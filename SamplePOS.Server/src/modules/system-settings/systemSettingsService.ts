import { Pool } from 'pg';
import { systemSettingsRepository } from './systemSettingsRepository.js';
import { SystemSettings, UpdateSystemSettingsDto } from '../../../../shared/types/systemSettings.js';
import logger from '../../utils/logger.js';
import { UnitOfWork } from '../../db/unitOfWork.js';
import { storeLocationRepository } from '../inventory/warehouse/storeLocationRepository.js';
import { clearMultistoreSettingsCache } from '../inventory/warehouse/multistoreSettings.js';
import { multistoreSellableBackfillService } from '../inventory/warehouse/multistoreSellableBackfillService.js';

export interface MultistoreToggleResult {
    settings: SystemSettings;
    multistoreBootstrap?: {
        enabled: boolean;
        storesEnsured: boolean;
        warnings?: string[];
        posSellableBackfill?: {
            lotsCreated: number;
            balancesSeeded: number;
            unitsMovedMainToSelling: number;
            unitsSeededOnSelling: number;
            batchesProcessed: number;
            warnings?: string[];
        };
    };
}

export const systemSettingsService = {
    /**
     * Get system settings
     */
    async getSettings(pool: Pool): Promise<SystemSettings> {
        const settings = await systemSettingsRepository.getSettings(pool);

        if (!settings) {
            // Initialize with defaults if not exists
            logger.info('System settings not found, initializing defaults');
            return await systemSettingsRepository.initializeDefaults(pool);
        }

        return settings;
    },

    /**
     * Update system settings
     */
    async updateSettings(
        pool: Pool,
        updates: UpdateSystemSettingsDto,
        userId?: string
    ): Promise<MultistoreToggleResult> {
        const updatesWithUser = {
            ...updates,
            updatedById: userId,
        };

        return UnitOfWork.run(pool, async (client) => {
            // Restaurant-domain SSOT: kitchen production cannot stay on when restaurant is off
            const gateUpdates =
                updates.restaurantModeEnabled === false
                    ? { ...updatesWithUser, kitchenProductionEnabled: false }
                    : updatesWithUser;

            const updated = await systemSettingsRepository.updateSettings(
                client,
                gateUpdates
            );

            let multistoreBootstrap: MultistoreToggleResult['multistoreBootstrap'];

            if (updates.isMultistoreEnabled !== undefined) {
                clearMultistoreSettingsCache();
                if (updates.isMultistoreEnabled) {
                    await storeLocationRepository.ensureDefaultNetworkStores(client);
                    // softAssert: residual drift after heal must not block enable (400 rollback).
                    const posSellableBackfill =
                        await multistoreSellableBackfillService.ensurePosSellableFromBatches(client, {
                            softAssert: true,
                        });
                    multistoreBootstrap = {
                        enabled: true,
                        storesEnsured: true,
                        warnings: posSellableBackfill.warnings?.length
                            ? posSellableBackfill.warnings
                            : undefined,
                        posSellableBackfill,
                    };
                    logger.info('Multistore enabled — store network + POS sellable backfill', {
                        updatedBy: userId,
                        posSellableBackfill,
                        warnings: posSellableBackfill.warnings,
                    });
                } else {
                    multistoreBootstrap = { enabled: false, storesEnsured: false };
                    logger.info('Multistore disabled — legacy inventory paths active', {
                        updatedBy: userId,
                    });
                }
            }

            logger.info('System settings updated (transaction committed)', {
                updatedBy: userId,
                changes: Object.keys(updates),
            });

            return { settings: updated, multistoreBootstrap };
        });
    },

    /**
     * Get tax configuration
     */
    async getTaxConfig(pool: Pool): Promise<{
        enabled: boolean;
        defaultRate: number;
        taxName: string;
        taxInclusive: boolean;
        rates: Array<{ name: string; rate: number; default?: boolean }>;
    }> {
        const settings = await this.getSettings(pool);

        return {
            enabled: settings.taxEnabled,
            defaultRate: settings.defaultTaxRate,
            taxName: settings.taxName,
            taxInclusive: settings.taxInclusive,
            rates: settings.taxRates,
        };
    },

    /**
     * Get printing configuration for receipts
     */
    async getReceiptPrintConfig(pool: Pool): Promise<{
        enabled: boolean;
        printerName?: string;
        guestBillPrinterName?: string;
        paperWidth: number;
        autoPrint: boolean;
        showLogo: boolean;
        logoUrl?: string;
        headerText?: string;
        footerText?: string;
        showTaxBreakdown: boolean;
        showQrCode: boolean;
    }> {
        const settings = await this.getSettings(pool);

        return {
            enabled: settings.receiptPrinterEnabled,
            printerName: settings.receiptPrinterName,
            guestBillPrinterName: settings.guestBillPrinterName,
            paperWidth: settings.receiptPaperWidth,
            autoPrint: settings.receiptAutoPrint,
            showLogo: settings.receiptShowLogo,
            logoUrl: settings.receiptLogoUrl,
            headerText: settings.receiptHeaderText,
            footerText: settings.receiptFooterText,
            showTaxBreakdown: settings.receiptShowTaxBreakdown,
            showQrCode: settings.receiptShowQrCode,
        };
    },

    /**
     * Guest bill / check printer — FOH restaurant bill destination.
     * Falls back to receipt printer when guest bill name is unset.
     */
    async getGuestBillPrintConfig(pool: Pool): Promise<{
        printerName: string | null;
    }> {
        const settings = await this.getSettings(pool);
        const dedicated = settings.guestBillPrinterName?.trim() || null;
        const receipt = settings.receiptPrinterName?.trim() || null;
        return { printerName: dedicated || receipt };
    },

    /**
     * Get printing configuration for invoices
     */
    async getInvoicePrintConfig(pool: Pool): Promise<{
        enabled: boolean;
        printerName?: string;
        paperSize: string;
        template: string;
        showLogo: boolean;
        showPaymentTerms: boolean;
        defaultPaymentTerms?: string;
    }> {
        const settings = await this.getSettings(pool);

        return {
            enabled: settings.invoicePrinterEnabled,
            printerName: settings.invoicePrinterName,
            paperSize: settings.invoicePaperSize,
            template: settings.invoiceTemplate,
            showLogo: settings.invoiceShowLogo,
            showPaymentTerms: settings.invoiceShowPaymentTerms,
            defaultPaymentTerms: settings.invoiceDefaultPaymentTerms,
        };
    },
};
