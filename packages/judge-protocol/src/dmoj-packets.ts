/** Bridge → judge. */
export interface SubmissionRequestPacket {
  name: 'submission-request';
  'submission-id': number;
  'problem-id': string;
  language: string;
  source: string;
  'time-limit': number;
  'memory-limit': number;
  'short-circuit': boolean;
  meta: Record<string, unknown>;
}

/** Judge → bridge, sent first; the bridge must answer `handshake-success`. */
export interface HandshakePacket {
  name: 'handshake';
  problems: Array<[string, number]>;
  executors: Record<string, unknown>;
  id: string;
  key: string;
}

export interface TestCaseStatusPacket {
  name: 'test-case-status';
  'submission-id': number;
  cases: Array<{
    position: number;
    /** DMOJ result bitmask — resolve with `interpretFlags`, never store raw. */
    status: number;
    time: number;
    points: number;
    'total-points': number;
    memory: number;
    output: string;
    feedback: string;
    'extended-feedback': string;
  }>;
}

export type JudgeToBridgePacket =
  | HandshakePacket
  | TestCaseStatusPacket
  | { name: 'supported-problems'; problems: Array<[string, number]> }
  | { name: 'grading-begin'; 'submission-id': number; pretested: boolean }
  | { name: 'grading-end'; 'submission-id': number }
  | { name: 'batch-begin'; 'submission-id': number }
  | { name: 'batch-end'; 'submission-id': number }
  | { name: 'compile-error'; 'submission-id': number; log: string }
  | { name: 'compile-message'; 'submission-id': number; log: string }
  | { name: 'internal-error'; 'submission-id': number; message: string }
  | { name: 'submission-terminated'; 'submission-id': number }
  | { name: 'submission-acknowledged'; 'submission-id': number }
  | { name: 'current-submission-id'; 'submission-id': number }
  | { name: 'ping-response'; when: number; time: number };

export type BridgeToJudgePacket =
  | SubmissionRequestPacket
  | { name: 'handshake-success' }
  | { name: 'ping'; when: number }
  | { name: 'terminate-submission' }
  | { name: 'disconnect' };
