export interface CustomerNoteRecord {
  id: string;
  customerId: string | null;
  customerEmail: string | null;
  customerName: string;
  note: string;
}

export interface NotableCustomer {
  customerId: string | null;
  customerEmail: string | null;
  customer: string;
}

// Matches a customer to their saved note, preferring the Shopify customer ID,
// then email, then exact (case-insensitive) name — since guest orders often
// have no customer ID and emails can be missing on some sales channels.
export function findCustomerNote(target: NotableCustomer, notes: CustomerNoteRecord[]): CustomerNoteRecord | null {
  if (target.customerId) {
    const byId = notes.find((n) => n.customerId === target.customerId);
    if (byId) return byId;
  }
  if (target.customerEmail) {
    const email = target.customerEmail.trim().toLowerCase();
    const byEmail = notes.find((n) => n.customerEmail?.trim().toLowerCase() === email);
    if (byEmail) return byEmail;
  }
  const name = target.customer.trim().toLowerCase();
  return notes.find((n) => n.customerName.trim().toLowerCase() === name) ?? null;
}
