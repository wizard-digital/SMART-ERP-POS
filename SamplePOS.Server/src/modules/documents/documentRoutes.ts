/**
 * Documents routes — central PDF rendering endpoint.
 *
 * GET /api/documents/:type/:id            → stream PDF (download)
 * GET /api/documents/:type/:id/preview    → stream PDF inline (for iframe preview)
 *
 * Query params:
 *   paperSize=A4|A5|LETTER|RECEIPT_80MM|RECEIPT_58MM   (default A4)
 *   variant=final|preview                              (default final)
 */

import { Router, type Request, type Response } from 'express';
import { PassThrough } from 'stream';
import { z } from 'zod';
import type { Pool } from 'pg';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { authenticate } from '../../middleware/auth.js';
import { requireDocumentPdfPermission } from '../../authorization/documentPermissionMiddleware.js';
import { render, type DocumentType } from './documentRenderer.js';

const SUPPORTED_TYPES = [
    'INVOICE',
    'RECEIPT',
    'QUOTATION',
    'PURCHASE_ORDER',
    'GOODS_RECEIPT',
    'STORE_ISSUE',
    'DELIVERY_NOTE',
    'CREDIT_NOTE',
    'CUSTOMER_STATEMENT',
    'SUPPLIER_STATEMENT',
    'SUPPLIER_INVOICE',
    'PAYMENT_VOUCHER',
    'PROFIT_LOSS',
    'BALANCE_SHEET',
    'TRIAL_BALANCE',
    'CASH_FLOW',
    'GENERAL_LEDGER',
    'AGED_RECEIVABLES',
    'AGED_PAYABLES',
] as const;

const ParamSchema = z.object({
    type: z.enum(SUPPORTED_TYPES),
    id: z.string().min(1),
});

const QuerySchema = z.object({
    paperSize: z.enum(['A4', 'A5', 'LETTER', 'RECEIPT_80MM', 'RECEIPT_58MM']).optional(),
    variant: z.enum(['final', 'preview']).optional(),
    startDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'startDate must be YYYY-MM-DD')
        .optional(),
    endDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'endDate must be YYYY-MM-DD')
        .optional(),
});

export function createDocumentRoutes(globalPool: Pool): Router {
    const router = Router();

    async function streamDocument(
        req: Request,
        res: Response,
        disposition: 'attachment' | 'inline',
    ): Promise<void> {
        const { type, id } = ParamSchema.parse(req.params);
        const query = QuerySchema.parse(req.query);
        const pool = req.tenantPool || globalPool;

        // Buffer the PDF in-memory so we can set BOTH Content-Type and
        // Content-Disposition (which depends on the renderer-derived filename)
        // BEFORE any bytes hit the response. Streaming straight to `res` would
        // commit the headers as soon as the renderer wrote its first chunk and
        // the later setHeader('Content-Disposition', ...) would be silently
        // dropped, leaving the browser to invent a filename from the URL.
        //
        // pdfkit's doc.end() flushes chunks ASYNCHRONOUSLY through doc.pipe(),
        // so we MUST wait for the PassThrough's 'end' event before concat —
        // returning early would yield an empty/truncated PDF.
        const buffer = new PassThrough();
        const chunks: Buffer[] = [];
        buffer.on('data', (chunk: Buffer) => chunks.push(chunk));
        const streamClosed = new Promise<void>((resolve, reject) => {
            buffer.once('end', resolve);
            buffer.once('error', reject);
        });

        const result = await render(
            pool,
            {
                type: type as DocumentType,
                id,
                paperSize: query.paperSize,
                variant: query.variant ?? 'final',
                startDate: query.startDate,
                endDate: query.endDate,
            },
            buffer,
        );
        await streamClosed;

        const pdf = Buffer.concat(chunks);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader(
            'Content-Disposition',
            `${disposition}; filename="${result.filename}"`,
        );
        res.setHeader('Content-Length', String(pdf.length));
        res.end(pdf);
    }

    router.get(
        '/:type/:id/preview',
        authenticate,
        requireDocumentPdfPermission(),
        asyncHandler(async (req, res) => {
            await streamDocument(req, res, 'inline');
        }),
    );

    router.get(
        '/:type/:id',
        authenticate,
        requireDocumentPdfPermission(),
        asyncHandler(async (req, res) => {
            await streamDocument(req, res, 'attachment');
        }),
    );

    return router;
}
