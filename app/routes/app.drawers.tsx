import { useEffect, useState } from "react";
import { Page, Layout, Card, Text, Button, TextField, InlineStack, BlockStack, Banner, Spinner } from "@shopify/polaris";
import { DeleteIcon } from "@shopify/polaris-icons";

interface DrawerRow {
  drawerNumber: number;
  startSku: string;
  endSku: string;
}

export default function Drawers() {
  const [rows, setRows] = useState<DrawerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: "success" | "critical" } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/drawers");
        const data = await res.json();
        const loaded: DrawerRow[] = (data.drawers ?? []).map((d: any) => ({
          drawerNumber: d.drawerNumber,
          startSku: d.startSku ?? "",
          endSku: d.endSku ?? "",
        }));
        setRows(loaded.length ? loaded : [{ drawerNumber: 1, startSku: "", endSku: "" }]);
      } catch (e) {
        console.error("Failed to load drawer config", e);
        setMessage({ text: "Failed to load drawer config.", tone: "critical" });
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  function updateRow(idx: number, patch: Partial<DrawerRow>) {
    setRows(rs => rs.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }

  function addRow() {
    const nextNumber = rows.length ? Math.max(...rows.map(r => r.drawerNumber)) + 1 : 1;
    setRows(rs => [...rs, { drawerNumber: nextNumber, startSku: "", endSku: "" }]);
  }

  function removeRow(idx: number) {
    setRows(rs => rs.filter((_, i) => i !== idx));
  }

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/drawers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          drawers: rows
            .filter(r => r.drawerNumber > 0)
            .map(r => ({
              drawerNumber: r.drawerNumber,
              startSku: r.startSku.trim() || null,
              endSku: r.endSku.trim() || null,
            })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Save failed");
      setMessage({ text: "Drawer setup saved.", tone: "success" });
    } catch (e: any) {
      setMessage({ text: e.message ?? "Failed to save drawer config.", tone: "critical" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Page title="Drawer Setup" subtitle="Assign SKU ranges to drawers so Pack Check can announce which drawer to use.">
      <Layout>
        <Layout.Section>
          {message && (
            <div style={{ marginBottom: 16 }}>
              <Banner tone={message.tone} onDismiss={() => setMessage(null)}>{message.text}</Banner>
            </div>
          )}
          <Card>
            {loading ? (
              <InlineStack align="center"><Spinner size="small" /></InlineStack>
            ) : (
              <BlockStack gap="400">
                <Text as="p" variant="bodyMd" tone="subdued">
                  Leave the end SKU blank to mean &ldquo;to current&rdquo; — the drawer will match every SKU from
                  the start onward with no upper bound. Leave both fields blank for a drawer that isn&rsquo;t in
                  use yet.
                </Text>

                <BlockStack gap="300">
                  <InlineStack gap="300" blockAlign="center">
                    <div style={{ width: 90 }}><Text as="span" variant="bodySm" fontWeight="bold">Drawer #</Text></div>
                    <div style={{ flex: 1 }}><Text as="span" variant="bodySm" fontWeight="bold">Start SKU</Text></div>
                    <div style={{ flex: 1 }}><Text as="span" variant="bodySm" fontWeight="bold">End SKU (blank = current)</Text></div>
                    <div style={{ width: 40 }} />
                  </InlineStack>

                  {rows.map((row, idx) => (
                    <InlineStack key={idx} gap="300" blockAlign="center">
                      <div style={{ width: 90 }}>
                        <TextField
                          label="" labelHidden type="number" autoComplete="off"
                          value={String(row.drawerNumber)}
                          onChange={(v) => updateRow(idx, { drawerNumber: parseInt(v, 10) || 0 })}
                        />
                      </div>
                      <div style={{ flex: 1 }}>
                        <TextField
                          label="" labelHidden autoComplete="off" placeholder="e.g. AA-001"
                          value={row.startSku}
                          onChange={(v) => updateRow(idx, { startSku: v })}
                        />
                      </div>
                      <div style={{ flex: 1 }}>
                        <TextField
                          label="" labelHidden autoComplete="off" placeholder="current"
                          value={row.endSku}
                          onChange={(v) => updateRow(idx, { endSku: v })}
                        />
                      </div>
                      <div style={{ width: 40 }}>
                        <Button icon={DeleteIcon} accessibilityLabel="Remove drawer" onClick={() => removeRow(idx)} variant="tertiary" tone="critical" />
                      </div>
                    </InlineStack>
                  ))}
                </BlockStack>

                <InlineStack gap="300">
                  <Button onClick={addRow}>Add drawer</Button>
                  <Button variant="primary" onClick={save} loading={saving}>Save</Button>
                </InlineStack>
              </BlockStack>
            )}
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
