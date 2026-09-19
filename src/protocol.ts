import type {ApiProtocol} from './region';

/** Shared by the picker and serializers: never silently translate max to high. */
export const PROTOCOL_CAPABILITIES = {
  'chat-completions': {efforts: ['low', 'high', 'max'], defaultEffort: 'max'},
  messages: {efforts: ['low', 'high', 'max'], defaultEffort: 'max'},
  responses: {efforts: ['low', 'high'], defaultEffort: 'high'},
} as const;

export function supportsEffort(protocol: ApiProtocol, effort: string): boolean {
  const efforts: readonly string[] = PROTOCOL_CAPABILITIES[protocol].efforts;
  return efforts.includes(effort);
}

export function parseApiProtocol(value: unknown): ApiProtocol {
  if (value === undefined) return 'chat-completions';
  if (
    value === 'chat-completions' ||
    value === 'messages' ||
    value === 'responses'
  ) {
    return value;
  }
  throw new Error(`Unsupported API protocol: ${String(value)}`);
}
