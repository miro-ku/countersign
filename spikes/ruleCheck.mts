// A rule made from a sentence, tried against actions as the gateway sees them.
import { ruleMatches } from '../server/gateway/rules.ts';

const rule: any = { _id: 'r', agentId: 'a', effect: 'deny', reason: '', match: { actionPattern: 'REFUND', conditions: [{ field: 'amount', op: 'gte', value: 3001 }] } };
const action = (name: string, args: unknown, identity?: unknown): any => ({ name, kind: 'write', args, identity, summary: '' });
console.log('49.00 refund, amount only in the canonical form:', ruleMatches(rule, action('STRIPE_CREATE_REFUND', { charge: 'ch_1' }, { charge: 'ch_1', amount: 4900 })));
console.log('20.00 refund:', ruleMatches(rule, action('STRIPE_CREATE_REFUND', { charge: 'ch_1', amount: 2000 })));
console.log('a 49.00 credit, not a refund:', ruleMatches(rule, action('STRIPE_CREATE_CUSTOMER_BALANCE_TRANSACTION', { amount: 4900 })));
