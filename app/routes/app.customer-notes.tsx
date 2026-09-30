import { useEffect, useMemo, useState } from "react";
import { Page, Layout, Card, Button, TextField, InlineStack, BlockStack, Banner, Spinner, Badge } from "@shopify/polaris";

interface NoteRecord {
  id: string;
  customerId: string | null;
  customerEmail: string | null;
  customerName: string;
  note: string;
}
interface DirectoryEntry {
  customerId: string | null;
  customerEmail: string | null;
  customerName: string;
  noteId: string | null;
  note: string;
}

export default function CustomerNotes() {
  const [notes, setNotes] = useState<NoteRecord[]>([]);
  const [orderCustomers, setOrderCustomers] = useState<{ customerId: string | null; customerEmail: string | null; customer: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<DirectoryEntry | null>(null);
  const [noteText, setNoteText] = useState("");
  const [nameField, setNameField] = useState("");
  const [emailField, setEmailField] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: "success" | "critical" } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [notesRes, ordersRes, recentRes] = await Promise.all([
          fetch("/api/customer-notes"), fetch("/api/orders"), fetch("/api/recent-customers"),
        ]);
        const notesData = await notesRes.json();
        const ordersData = await ordersRes.json();
        const recentData = await recentRes.json();
        setNotes(notesData.notes ?? []);
        const seen = new Set<string>();
        const customers: { customerId: string | null; customerEmail: string | null; customer: string }[] = [];
        // Open (unfulfilled) orders plus anyone who ordered in the last 5 days,
        // regardless of fulfillment status, so recently-fulfilled customers are searchable too.
        const sources = [...(ordersData.orders ?? []), ...(recentData.customers ?? [])];
        for (const o of sources) {
          const key = o.customerId || o.customerEmail || o.customer;
          if (!key || seen.has(key)) continue;
          seen.add(key);
          customers.push({ customerId: o.customerId ?? null, customerEmail: o.customerEmail ?? null, customer: o.customer });
        }
        setOrderCustomers(customers);
        if (recentData.error) {
          setMessage({ text: `Couldn't load the last 5 days of order history (showing only currently open orders): ${recentData.error}`, tone: "critical" });
        }
      } catch (e) {
        console.error("Failed to load customer notes", e);
        setMessage({ text: "Failed to load customer notes.", tone: "critical" });
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Existing notes first (authoritative), then currently-open-order customers
  // who don't have a note yet — so you can search by name whether or not
  // they've been noted before.
  const directory = useMemo<DirectoryEntry[]>(() => {
    const entries: DirectoryEntry[] = notes.map((n) => ({
      customerId: n.customerId, customerEmail: n.customerEmail, customerName: n.customerName,
      noteId: n.id, note: n.note,
    }));
    for (const c of orderCustomers) {
      const alreadyNoted = entries.some((e) =>
        (c.customerId && e.customerId === c.customerId) ||
        (c.customerEmail && e.customerEmail?.toLowerCase() === c.customerEmail.toLowerCase()) ||
        (!c.customerId && !c.customerEmail && e.customerName.toLowerCase() === c.customer.toLowerCase()),
      );
      if (!alreadyNoted) {
        entries.push({ customerId: c.customerId, customerEmail: c.customerEmail, customerName: c.customer, noteId: null, note: "" });
      }
    }
    return entries;
  }, [notes, orderCustomers]);

  const filtered = search.trim()
    ? directory.filter((e) => e.customerName.toLowerCase().includes(search.trim().toLowerCase()))
    : directory;

  function selectEntry(entry: DirectoryEntry) {
    setSelected(entry);
    setNameField(entry.customerName);
    setEmailField(entry.customerEmail ?? "");
    setNoteText(entry.note);
    setMessage(null);
  }

  function startNew() {
    setSelected({ customerId: null, customerEmail: null, customerName: "", noteId: null, note: "" });
    setNameField("");
    setEmailField("");
    setNoteText("");
    setMessage(null);
  }

  async function save() {
    if (!selected) return;
    if (!nameField.trim() || !noteText.trim()) {
      setMessage({ text: "Customer name and note are both required.", tone: "critical" });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/customer-notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: selected.noteId ?? undefined,
          customerId: selected.customerId,
          customerEmail: emailField.trim() || null,
          customerName: nameField.trim(),
          note: noteText.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Save failed");
      const reload = await (await fetch("/api/customer-notes")).json();
      setNotes(reload.notes ?? []);
      setMessage({ text: "Note saved.", tone: "success" });
    } catch (e: any) {
      setMessage({ text: e.message ?? "Failed to save note.", tone: "critical" });
    } finally {
      setSaving(false);
    }
  }

  async function removeNote() {
    if (!selected?.noteId) return;
    if (!confirm(`Delete the note for ${selected.customerName}?`)) return;
    setSaving(true);
    try {
      const res = await fetch("/api/customer-notes", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: selected.noteId }),
      });
      if (!res.ok) throw new Error("Delete failed");
      setNotes((ns) => ns.filter((n) => n.id !== selected.noteId));
      setSelected(null);
      setMessage({ text: "Note deleted.", tone: "success" });
    } catch (e: any) {
      setMessage({ text: e.message ?? "Failed to delete note.", tone: "critical" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Page title="Customer Notes" subtitle="Search a customer and add a note — it shows in bright orange in Pack Check when they order.">
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
                <InlineStack gap="300" blockAlign="center">
                  <div style={{ flex: 1 }}>
                    <TextField label="" labelHidden autoComplete="off" placeholder="Search customers by name…" value={search} onChange={setSearch} />
                  </div>
                  <Button onClick={startNew}>+ Add note</Button>
                </InlineStack>

                <div style={{ maxHeight: 280, overflowY: "auto", border: "1px solid #e1e1e1", borderRadius: 8 }}>
                  {filtered.length === 0 ? (
                    <div style={{ padding: 14, color: "#888", fontSize: 13 }}>No customers found.</div>
                  ) : filtered.map((e, i) => (
                    <div
                      key={`${e.customerId ?? e.customerEmail ?? e.customerName}-${i}`}
                      onClick={() => selectEntry(e)}
                      style={{
                        padding: "10px 14px", cursor: "pointer",
                        borderBottom: i < filtered.length - 1 ? "1px solid #f0f0f0" : "none",
                        background: selected && selected.noteId === e.noteId && selected.customerName === e.customerName ? "#f0f4ff" : "transparent",
                        display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10,
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>{e.customerName}</div>
                        {e.customerEmail && <div style={{ fontSize: 12, color: "#888" }}>{e.customerEmail}</div>}
                      </div>
                      {e.noteId && <Badge tone="warning">Has note</Badge>}
                    </div>
                  ))}
                </div>

                {selected && (
                  <BlockStack gap="300">
                    <InlineStack gap="300">
                      <div style={{ flex: 1 }}>
                        <TextField label="Customer name" autoComplete="off" value={nameField} onChange={setNameField} />
                      </div>
                      <div style={{ flex: 1 }}>
                        <TextField label="Email (optional)" autoComplete="off" value={emailField} onChange={setEmailField} />
                      </div>
                    </InlineStack>
                    <TextField label="Note" autoComplete="off" multiline={3} value={noteText} onChange={setNoteText} placeholder="e.g. Always wants gift wrap included" />
                    <InlineStack gap="300">
                      <Button variant="primary" onClick={save} loading={saving}>Save note</Button>
                      {selected.noteId && <Button tone="critical" onClick={removeNote} loading={saving}>Delete note</Button>}
                    </InlineStack>
                  </BlockStack>
                )}
              </BlockStack>
            )}
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
