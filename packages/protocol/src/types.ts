export type RuntimeName = "pi" | "codex" | "claude" | (string & {});

export interface NodeInfo {
  nodeId: string;
  nodeName: string;
  hostname: string;
  deviceId: string;
  publicKeyJwk: JsonWebKey;
  email: string;
  createdAt: number;
  lastSeenAt: number;
  revokedAt?: number;
}

export interface SessionInfo {
  id: string;
  name: string;
  nodeId: string;
  nodeName: string;
  address: string;
  cwd: string;
  model: string;
  runtime: RuntimeName;
  pid: number;
  startedAt: number;
  lastActivity: number;
  status?: string;
}

export interface Attachment {
  type: "file" | "snippet" | "context";
  name: string;
  content: string;
  language?: string;
}

export interface AgentComMessage {
  id: string;
  timestamp: number;
  replyTo?: string;
  expectsReply?: boolean;
  content: {
    text: string;
    attachments?: Attachment[];
  };
}

export interface SessionRegistration {
  name?: string;
  cwd: string;
  model: string;
  runtime: RuntimeName;
  pid: number;
  startedAt: number;
  lastActivity: number;
  status?: string;
}
