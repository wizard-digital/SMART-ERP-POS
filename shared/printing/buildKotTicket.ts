/**
 * Build canonical ThermalTicket from KOT print fields (FOH / dispatcher).
 */
import { consolidateKotLines } from '../utils/consolidateKotLines.js';
import type { ThermalTicket } from './thermalTicket.js';

export type KotTicketInput = {
  kotNumber: string;
  station: string;
  tableLabel: string;
  waiterName?: string | null;
  sentByName?: string | null;
  serverName?: string | null;
  firedAt: string;
  ticketKind?: 'FIRE' | 'VOID' | null;
  voidReason?: string | null;
  orderChannel?: string | null;
  guestName?: string | null;
  guestPhone?: string | null;
  deliveryAddress?: string | null;
  pickupLabel?: string | null;
  companyName?: string | null;
  companyAddress?: string | null;
  companyPhone?: string | null;
  items: Array<{ productName: string; quantity: number; lineNotes?: string | null }>;
};

export function resolveKotStaffLabels(input: {
  sentByName?: string | null;
  stewardName?: string | null;
  serverName?: string | null;
  waiterName?: string | null;
}): { steward: string | null; server: string | null } {
  const steward =
    (input.sentByName || input.stewardName || input.waiterName || '').trim() || null;
  const server = (input.serverName || '').trim() || null;
  if (server && steward && server === steward) {
    return { steward, server: null };
  }
  return { steward, server };
}

export function buildKotThermalTicket(input: KotTicketInput): ThermalTicket {
  const isVoid = input.ticketKind === 'VOID';
  const staff = resolveKotStaffLabels(input);
  const consolidated = consolidateKotLines(
    input.items.map((it) => ({
      productName: it.productName,
      quantity: it.quantity,
      lineNotes: it.lineNotes ?? null,
    })),
  );

  return {
    kind: isVoid ? 'KOT_VOID' : 'KOT_FIRE',
    station: input.station,
    title: isVoid ? '*** VOID ***' : `${input.station} ORDER`,
    documentNumber: input.kotNumber,
    tableLabel: input.tableLabel,
    stewardName: staff.steward,
    serverName: staff.server,
    firedAt: input.firedAt,
    voidReason: isVoid ? input.voidReason || null : null,
    orderChannel: input.orderChannel || null,
    guestName: input.guestName || null,
    guestPhone: input.guestPhone || null,
    deliveryAddress: input.deliveryAddress || null,
    pickupLabel: input.pickupLabel || null,
    companyName: input.companyName || null,
    companyAddress: input.companyAddress || null,
    companyPhone: input.companyPhone || null,
    items: consolidated.map((it) => ({
      quantity: it.quantity,
      name: it.productName,
      note: it.lineNotes,
    })),
    footerLines: isVoid ? ['STOP /', 'DO NOT PREPARE'] : ['NO PRICES'],
  };
}
