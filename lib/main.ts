import { PostgrestClient } from "@supabase/postgrest-js";
import Keycloak from "keycloak-js";
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

export type LeafogConfig = {
  url: string;
  projectId: string;
  s3Endpoint: string;
  schema?: string;
};
import { S3Client } from "@aws-sdk/client-s3";

const EX_CHANGE_BODY = {
  grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
  audience: "minio",
  requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
};
export class Leafog<T> {
  #xmlParse = new DOMParser();
  #config: LeafogConfig;
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

  constructor(config: LeafogConfig) {
    this.#config = config;
    const { url, projectId } = config;
    this.#kc = new Keycloak({
      url: `${url}/auth`,
      realm: "Leafog",
      clientId: projectId,
    });

    this.auth = {
      kc: this.#kc,
      rest: new PostgrestClient<Auth>(`${url}/pgrst`, {
        fetch: this.#withAuthFetch,
      }),
    };

    this.rest = new PostgrestClient<T>(`${url}/pgrst`, {
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
    if (this.#kc.authenticated && this.#kc.token) {
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
      `${this.#config.url}/auth/realms/Leafog/protocol/openid-connect/token`,
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
      credentials: async () => {
        return (
          this.#s3cert ?? {
            accessKeyId: "",
            secretAccessKey: "",
            sessionToken: "",
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
    minioTokenUrl.searchParams.append("Leafog-server", "minio");

    fetch(minioTokenUrl, {
      method: "post",
    })
      .then((res) => res.text())
      .then((res: string) => {
        const xml = this.#xmlParse.parseFromString(res, "text/xml");
        const accessKeyId =
          xml.getElementsByTagName("AccessKeyId")[0].innerHTML;
        const secretAccessKey =
          xml.getElementsByTagName("SecretAccessKey")[0].innerHTML;
        const sessionToken =
          xml.getElementsByTagName("SessionToken")[0].innerHTML;
        const expiration = new Date(
          xml.getElementsByTagName("Expiration")[0].innerHTML
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
