import { PostgrestClient } from "@supabase/postgrest-js";
import Keycloak from "keycloak-js";

import { S3Client } from "@aws-sdk/client-s3";
type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

interface Auth {
  auth: {
    Tables: {
      [_ in never]: never;
    };
    Views: {
      user: {
        Row: {
          created_timestamp: number | null;
          email: string | null;
          email_verified: boolean | null;
          enabled: boolean | null;
          first_name: string | null;
          last_name: string | null;
          user_attributes: Json | null;
          username: string | null;
        };
        Relationships: [];
      };
    };
    Functions: {
      email: {
        Args: Record<PropertyKey, never>;
        Returns: string;
      };
      jwt: {
        Args: Record<PropertyKey, never>;
        Returns: Json;
      };
      roles: {
        Args: Record<PropertyKey, never>;
        Returns: Json;
      };
      uid: {
        Args: Record<PropertyKey, never>;
        Returns: string;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
}

export type LeafogConfig<
  T = any,
  SchemaName extends string & keyof T = "public" extends keyof T
    ? "public"
    : string & keyof T
> = {
  url: string;
  projectId: string;
  s3Endpoint: string;
  schema?: SchemaName;
};

const EX_CHANGE_BODY = {
  grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
  audience: "minio",
  requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
};
const KC_REALM_NAME = "leafog";
export class Leafog<T = any> {
  #xmlParse = new DOMParser();
  #config: LeafogConfig<T>;
  #kc: Keycloak;
  #withAuthFetch: typeof fetch = (...args) => {
    const authHeader: HeadersInit = this.#kc.token
      ? { Authorization: `Bearer ${this.#kc.token}` }
      : {};
    let originHeader: HeadersInit | undefined = args[1]?.headers;
    if (originHeader) {
      originHeader = { ...authHeader, ...originHeader };
    }
    return fetch(args[0], { ...args[1], headers: originHeader });
  };
  #s3cert:
    | {
        accessKeyId: string;
        secretAccessKey: string;
        sessionToken: string;
        expiration: Date | undefined;
      }
    | undefined = undefined;

  auth: {
    kc: Keycloak;
    rest: PostgrestClient<Auth>;
  };
  rest: PostgrestClient<T>;

  s3Client: S3Client;

  constructor(config: LeafogConfig<T>) {
    this.#config = config;
    const { url, projectId } = config;
    this.#kc = new Keycloak({
      url: `${url}/auth`,
      realm: KC_REALM_NAME,
      clientId: projectId,
    });

    this.auth = {
      kc: this.#kc,
      rest: new PostgrestClient<Auth>(`${url}/pgrst`, {
        schema: "auth",
        fetch: this.#withAuthFetch,
      }),
    };

    this.rest = new PostgrestClient<T>(`${url}/pgrst`, {
      schema: this.#config.schema,
      fetch: this.#withAuthFetch,
    });
    this.s3Client = this.#initS3Client();
    this.#handlerKc();
  }

  #handlerKc = () => {
    setInterval(() => {
      if (this.#kc.authenticated) {
        this.#kc.updateToken(5);
      }
    }, 3000);
    this.#kc.onAuthSuccess = () => {
      this.#exChangeTokenWithKc();
    };
    this.#kc.onAuthRefreshSuccess = () => {
      this.#exChangeTokenWithKc();
    };
    this.#kc.init({ onLoad: "check-sso" }).then((auth) => {
      if (auth) {
        // todo handler hash
        history.replaceState(null, "", location.pathname + location.search);
      }
    });
  };
  #exChangeTokenWithKc = () => {
    if (
      this.#kc.authenticated &&
      this.#kc.token &&
      this.#kc.idTokenParsed?.minio_policy
    ) {
      this.#exChangeToken(this.#kc.token);
    }
  };
  #exChangeToken = (token: string) => {
    const body = new URLSearchParams();
    Object.entries({
      ...EX_CHANGE_BODY,
      subject_token: token,
      client_id: this.#config.projectId,
    }).forEach(([k, v]) => {
      body.append(k, v);
    });

    fetch(
      `${
        this.#config.url
      }/auth/realms/${KC_REALM_NAME}/protocol/openid-connect/token`,
      {
        method: "post",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      }
    )
      .then((res) => res.json())
      .then((res) => {
        this.#minioTokenToS3Token(res.access_token);
      });
  };
  #initS3Client = () => {
    return new S3Client({
      endpoint: `${this.#config.s3Endpoint}`,
      region: "us-east-1",
      serviceId: "s3",
      forcePathStyle: true,
      credentials: async () => {
        return (
          this.#s3cert ?? {
            accessKeyId: "",
            secretAccessKey: "",
            sessionToken: "",
            expiration: new Date(0),
          }
        );
      },
    });
  };
  #minioTokenToS3Token = (minioToken: string) => {
    const minioTokenUrl = new URL(`${this.#config.s3Endpoint}`);
    minioTokenUrl.searchParams.append("Action", "AssumeRoleWithClientGrants");
    minioTokenUrl.searchParams.append("Version", "2011-06-15");
    minioTokenUrl.searchParams.append("Token", minioToken);

    fetch(minioTokenUrl, {
      method: "post",
    })
      .then((res) => res.text())
      .then((res: string) => {
        const xml = this.#xmlParse.parseFromString(res, "text/xml");
        const errorMsg = xml.querySelector(
          "ErrorResponse Error Message"
        )?.innerHTML;
        if (errorMsg) {
          throw new Error(errorMsg);
        }
        const accessKeyId = xml.querySelector("AccessKeyId")?.innerHTML ?? "";

        const secretAccessKey =
          xml.querySelector("SecretAccessKey")?.innerHTML ?? "";
        const sessionToken = xml.querySelector("SessionToken")?.innerHTML ?? "";

        const expiration = new Date(
          xml.querySelector("Expiration")?.innerHTML ?? 0
        );
        return { accessKeyId, secretAccessKey, sessionToken, expiration };
      })
      .then((res) => {
        this.#s3cert = {
          accessKeyId: res.accessKeyId,
          secretAccessKey: res.secretAccessKey,
          sessionToken: res.sessionToken,
          expiration: res.expiration,
        };

        this.s3Client = this.#initS3Client();
      });
  };
}
