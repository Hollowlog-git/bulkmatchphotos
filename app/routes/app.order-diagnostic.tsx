import { useState } from "react";
import { BlockStack, Button, Card, InlineStack, Layout, Page, Text, TextField } from "@shopify/polaris";

// Read-only page for /api/order-diagnostic: look up one order and copy the
// redacted reference fields to share with the local Trade Me app's developer.
export default function OrderDiagnostic() {
  const [order, setOrder] = useState("");
  const [result, setResult] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  async function lookUp() {
    if (!order.trim()) return;
    setLoading(true);
    setCopied(false);
    try {
      const res = await fetch(`/api/order-diagnostic?order=${encodeURIComponent(order.trim())}`);
      setResult(JSON.stringify(await res.json(), null, 2));
    } catch (e: any) {
      setResult(JSON.stringify({ error: e.message }, null, 2));
    } finally {
      setLoading(false);
    }
  }

  async function copy() {
    try { await navigator.clipboard.writeText(result); setCopied(true); } catch { setCopied(false); }
  }

  return (
    <Page title="Order reference diagnostic" subtitle="Read-only. Shows where an order stores Trade Me references; customer details are not fetched.">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack gap="200" blockAlign="end" wrap={false}>
                <div style={{ flex: 1 }}>
                  <TextField label="Order number" value={order} onChange={setOrder} autoComplete="off" placeholder="SO4392 or #6853" />
                </div>
                <Button variant="primary" onClick={lookUp} loading={loading}>Look up</Button>
              </InlineStack>
              {result && (
                <BlockStack gap="200">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingSm">Result</Text>
                    <Button onClick={copy}>{copied ? "Copied" : "Copy"}</Button>
                  </InlineStack>
                  <pre style={{ background: "#f6f6f7", padding: 12, borderRadius: 8, overflowX: "auto", fontSize: 12, maxHeight: 600 }}>{result}</pre>
                </BlockStack>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
