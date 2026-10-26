/**
 * The complete surface an AI client (ChatGPT, Claude, an MCP server, the future HTTP endpoint) is given.
 *
 * Two operations: submit a booking job, read a job's status. Nothing here can change limits, reset the
 * circuit breaker, enable or disable submissions, or reconcile outcomes. Those exist only in the owner
 * CLI, which connects with a different database role whose credentials the agent never has.
 *
 * Natural-language text an AI places in a request (notes, names) is data. No code path reads it as an
 * instruction, and the request schema rejects any field it does not define.
 */
import type { BookingRunner, BookingResult } from '../booking/runner.js';
import type { SafetyGate, JobRecord } from '../safety/gate.js';
import type { DuplicateMatch } from '../spectora/duplicateCheck.js';

/** What the AI is told about a possible duplicate: only that one exists and whether it is certain. */
export interface AgentDuplicate { kind: DuplicateMatch['kind'] }
export type AgentBookingResult = Omit<BookingResult, 'duplicates'> & { duplicates?: AgentDuplicate[] };

export interface AgentInterface {
  submitBooking(idempotencyKey: string, request: unknown): Promise<AgentBookingResult>;
  /** By the job id, or by the idempotency key the client chose. */
  getBookingStatus(jobIdOrKey: string): Promise<JobRecord | null>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createAgentInterface(runner: BookingRunner, gate: SafetyGate): AgentInterface {
  return Object.freeze({
    submitBooking: async (idempotencyKey: string, request: unknown): Promise<AgentBookingResult> => {
      const { duplicates, ...res } = await runner.run(idempotencyKey, request);
      // A possible match can be another customer's inspection. The AI learns only that one exists and
      // whether it is certain; not its id, time, address, or how the customer matched, which would let a
      // client probe Spectora for other people's bookings. The owner sees the detail in the job record.
      return duplicates ? { ...res, duplicates: duplicates.map((d) => ({ kind: d.kind })) } : res;
    },
    getBookingStatus: (ref: string) => (typeof ref !== 'string' ? Promise.resolve(null)
      : UUID.test(ref) ? gate.getJob(ref) : gate.getJobByKey(ref)),
  });
}
