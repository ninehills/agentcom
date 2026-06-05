export interface AgentComCredential {
  deviceId: string;
  nodeId: string;
  nodeName: string;
  privateKeyJwk: JsonWebKey;
  publicKeyJwk?: JsonWebKey;
  createdAt?: number;
  updatedAt?: number;
}
