export interface OcltStakeData {
  _id: number;
  symbol: 'OCLT';
  account: string;
  balance: string;
  stake: string;
  pendingUnstake?: string;
  delegationsOut: string;
  delegationsIn: string;
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number; // Unique ID for correlation
  method: string;
  params: {
    contract: 'tokens';
    table: string;
    query: {
      symbol: string;
      account: string;
    };
  };
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result: OcltStakeData | null; // null if the user has no stake
  error?: {
    code: number;
    message: string;
  };
}

// The entire batch response is an array of individual responses
export type BatchResponse = JsonRpcResponse[];