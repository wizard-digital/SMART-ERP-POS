import type {
  StoreIssueDocumentType,
  StoreIssueIssuedTo,
  StoreIssuePostingIntent,
  StoreIssueStatus,
} from './issuePlan.js';

export interface StoreIssueLineInput {
  productId: string;
  requestedQtyBase: number;
  issuedQtyBase: number;
  sortOrder?: number;
  notes?: string | null;
  uomId?: string | null;
  uomName?: string | null;
  conversionFactor?: number;
}

export interface StoreIssueDraftInput {
  issueDate?: string;
  storeLocationId?: string | null;
  issuedTo?: StoreIssueIssuedTo;
  requestedByName?: string | null;
  notes?: string | null;
  lines: StoreIssueLineInput[];
  documentType?: StoreIssueDocumentType;
  postingIntent?: StoreIssuePostingIntent;
}

export interface StoreIssueLine {
  id: string;
  documentId: string;
  productId: string;
  productName?: string;
  sku?: string | null;
  requestedQtyBase: number;
  issuedQtyBase: number;
  actualUnitCost: number | null;
  actualLineCost: number | null;
  sortOrder: number;
  notes: string | null;
  uomId: string | null;
  uomName: string | null;
  conversionFactor: number;
}

export interface StoreIssueDocument {
  id: string;
  documentNumber: string;
  documentType: StoreIssueDocumentType;
  postingIntent: StoreIssuePostingIntent;
  status: StoreIssueStatus;
  issueDate: string;
  storeLocationId: string | null;
  storeLocationName?: string;
  issuedTo: StoreIssueIssuedTo;
  requestedByName: string | null;
  notes: string | null;
  expenseAccountCode: string;
  totalCost: number;
  journalEntryId: string | null;
  createdBy: string;
  createdAt: string;
  postedBy: string | null;
  postedAt: string | null;
  reversedBy: string | null;
  reversedAt: string | null;
  reversalJournalId: string | null;
  reversalReason: string | null;
  lines: StoreIssueLine[];
}
