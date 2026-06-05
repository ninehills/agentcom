import type { AgentComMessage, SessionInfo, SessionRegistration } from "./types.ts";

export type AuthMessage =
  | {
      type: "register_device";
      requestId: string;
      deviceToken: string;
      hostname: string;
      preferredNodeName?: string;
      publicKeyJwk: JsonWebKey;
      session: SessionRegistration;
    }
  | { type: "auth_begin"; requestId: string; deviceId: string }
  | {
      type: "auth_finish";
      requestId: string;
      deviceId: string;
      signature: string;
      session: SessionRegistration;
    };

export type AuthResponse =
  | {
      type: "register_ok";
      requestId: string;
      sessionId: string;
      deviceId: string;
      nodeId: string;
      nodeName: string;
    }
  | { type: "register_failed"; requestId: string; reason: string }
  | { type: "auth_challenge"; requestId: string; nonce: string }
  | { type: "auth_failed"; requestId: string; reason: string };

export type ClientMessage =
  | { type: "list"; requestId: string }
  | { type: "send"; to: string; msg: AgentComMessage }
  | { type: "presence"; name?: string; status?: string; model?: string }
  | { type: "rename_node"; requestId: string; nodeName: string }
  | { type: "unregister" };

export type ServerMessage =
  | { type: "sessions"; requestId: string; sessions: SessionInfo[] }
  | { type: "message"; from: SessionInfo; msg: AgentComMessage }
  | { type: "delivered"; messageId: string }
  | { type: "delivery_failed"; messageId: string; reason: string }
  | { type: "session_joined"; session: SessionInfo }
  | { type: "session_left"; sessionId: string }
  | { type: "presence_update"; session: SessionInfo }
  | { type: "node_renamed"; requestId: string; nodeId: string; nodeName: string }
  | { type: "error"; err: string };

export type IncomingMessage = AuthMessage | ClientMessage;
export type OutgoingMessage = AuthResponse | ServerMessage;
