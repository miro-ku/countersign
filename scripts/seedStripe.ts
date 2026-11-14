// Puts the demo's customers and payments into a Stripe sandbox.
//   pnpm exec tsx scripts/seedStripe.ts [--fresh]
// It only ever runs with a test-mode key, and skips what is already there.
import 'dotenv/config';

const key = process.env.STRIPE_TEST_KEY ?? '';
if (!key.startsWith('sk_test_')) {
  console.error('STRIPE_TEST_KEY must be a test-mode key (sk_test_…). Nothing was done.');
  process.exit(1);
}

async function stripe(method: 'GET' | 'POST', path: string, params: Record<string, string> = {}): Promise<any> {
  const query = new URLSearchParams(params).toString();
  const response = await fetch(`https://api.stripe.com/v1${path}${method === 'GET' && query ? `?${query}` : ''}`, {
    method,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: method === 'POST' ? query : undefined,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${body.error?.message ?? response.status}`);
  return body;
}

interface Payment { amount: number; description: string }
const CUSTOMERS: Array<{ name: string; email: string; payments: Payment[] }> = [
  {
    name: 'Acme Corp',
    email: 'billing@acme.example',
    payments: [
      { amount: 4900, description: 'Pro plan, October' },
      // The duplicate the customer writes in about.
      { amount: 4900, description: 'Pro plan, October' },
      { amount: 50000, description: 'Annual plan' },
    ],
  },
  {
    name: 'Globex',
    email: 'accounts@globex.example',
    payments: [
      // A duplicate too large for an agent to refund: the rule stops it.
      { amount: 50000, description: 'Annual plan' },
      { amount: 50000, description: 'Annual plan' },
    ],
  },
];

// --fresh starts over: the demo spends a refund each time it runs.
if (process.argv.includes('--fresh')) {
  for (const wanted of CUSTOMERS) {
    const old = await stripe('GET', '/customers', { email: wanted.email, limit: '10' });
    for (const customer of old.data) {
      await fetch(`https://api.stripe.com/v1/customers/${customer.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${key}` } });
      console.log(`removed ${wanted.name} (${customer.id})`);
    }
  }
}

for (const wanted of CUSTOMERS) {
  const found = await stripe('GET', '/customers', { email: wanted.email, limit: '1' });
  const customer = found.data[0] ?? (await stripe('POST', '/customers', { name: wanted.name, email: wanted.email }));
  const existing = await stripe('GET', '/payment_intents', { customer: customer.id, limit: '20' });
  const paid: any[] = existing.data.filter((p: any) => p.status === 'succeeded');
  console.log(`${wanted.name} (${customer.id}): ${paid.length} payment(s) already there`);
  for (const payment of wanted.payments.slice(paid.length)) {
    const intent = await stripe('POST', '/payment_intents', {
      amount: String(payment.amount),
      currency: 'usd',
      customer: customer.id,
      description: payment.description,
      payment_method: 'pm_card_visa',
      confirm: 'true',
      'automatic_payment_methods[enabled]': 'true',
      'automatic_payment_methods[allow_redirects]': 'never',
    });
    console.log(`  paid ${(payment.amount / 100).toFixed(2)} USD: ${payment.description} (${intent.id}, ${intent.status})`);
  }
}
console.log('Done.');
