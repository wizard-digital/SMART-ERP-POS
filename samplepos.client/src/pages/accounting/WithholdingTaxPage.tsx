import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  useWhtTypes,
  useCreateWhtType,
  useWhtBalance,
  useRemitWht,
  useRecoverWhtReceivable,
  useWhtCertificates,
} from '../../hooks/useAccountingModules';
import { usePaymentAccounts } from '../../hooks/useExpenses';
import { useTransactionGuard, ZINDEX } from '../../hooks/useTransactionGuard';
import type { GuardHandle } from '../../hooks/useTransactionGuard';
import { useSubmitOnEnter } from '../../hooks/useSubmitOnEnter';
import { DatePicker } from '../../components/ui/date-picker';
import { ResponsiveTableWrapper } from '../../components/ui/ResponsiveTableWrapper';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '../../components/ui/temp-ui-components';
import { Receipt, Plus, Landmark, Banknote, FileBarChart2, ListOrdered } from 'lucide-react';

interface WhtType {
  id: string;
  code: string;
  name: string;
  rate: number;
  appliesTo: string;
  thresholdAmount?: number;
  accountCode?: string;
  isActive: boolean;
}

interface WhtSideBalance {
  balance?: number;
  entries?: number;
  accountCode?: string;
}

interface WhtBalanceData {
  balance?: number;
  entries?: number;
  payable?: WhtSideBalance;
  receivable?: WhtSideBalance;
}

interface WhtCertificate {
  id: string;
  certificateNumber: string;
  createdAt: string;
  transactionType: string;
  paymentNumber?: string | null;
  paymentDate?: string | null;
  partyName?: string | null;
  whtTypeName?: string | null;
  baseAmount: number;
  whtAmount: number;
  netAmount: number;
}

const todayIso = () => new Date().toLocaleDateString('en-CA');

const emptyTypeForm = {
  code: '',
  name: '',
  rate: 6,
  appliesToSuppliers: true,
  appliesToCustomers: false,
};

export default function WithholdingTaxPage() {
  const [activeTab, setActiveTab] = useState('types');
  const [isTypeModalOpen, setIsTypeModalOpen] = useState(false);
  const [isRemitModalOpen, setIsRemitModalOpen] = useState(false);
  const [isRecoverModalOpen, setIsRecoverModalOpen] = useState(false);

  const { data: types, isLoading } = useWhtTypes();
  const { data: balanceData } = useWhtBalance();
  const { data: certificatesRaw } = useWhtCertificates();
  const { data: paymentAccounts = [] } = usePaymentAccounts();
  const createMutation = useCreateWhtType();
  const remitMutation = useRemitWht();
  const recoverMutation = useRecoverWhtReceivable();

  const { openGuard, closeGuard } = useTransactionGuard();
  const remitGuardRef = useRef<GuardHandle | null>(null);
  const recoverGuardRef = useRef<GuardHandle | null>(null);

  const [form, setForm] = useState(emptyTypeForm);
  const [remitForm, setRemitForm] = useState({
    amount: '',
    date: todayIso(),
    reference: '',
    paymentAccountCode: '',
  });
  const [recoverForm, setRecoverForm] = useState({
    amount: '',
    date: todayIso(),
    reference: '',
    paymentAccountCode: '',
  });

  const items = (Array.isArray(types) ? types : []) as WhtType[];
  const certificates = (Array.isArray(certificatesRaw) ? certificatesRaw : []) as WhtCertificate[];
  const balance = (balanceData || {}) as WhtBalanceData;
  const payable = balance.payable ?? {
    balance: balance.balance,
    entries: balance.entries,
    accountCode: '2350',
  };
  const receivable = balance.receivable ?? { balance: 0, entries: 0, accountCode: '1250' };

  const cashOptions = useMemo(() => {
    const fromApi = paymentAccounts.filter((a) => a.code);
    if (fromApi.length > 0) return fromApi;
    return [
      { id: '1010', code: '1010', name: 'Cash', type: 'ASSET' },
      { id: '1030', code: '1030', name: 'Checking Account', type: 'ASSET' },
      { id: '1015', code: '1015', name: 'Undeposited Funds', type: 'ASSET' },
    ];
  }, [paymentAccounts]);

  useEffect(() => {
    if (!cashOptions.length) return;
    const defaultCode = cashOptions.find((a) => a.code === '1010')?.code ?? cashOptions[0]!.code;
    setRemitForm((prev) => (prev.paymentAccountCode ? prev : { ...prev, paymentAccountCode: defaultCode }));
    setRecoverForm((prev) => (prev.paymentAccountCode ? prev : { ...prev, paymentAccountCode: defaultCode }));
  }, [cashOptions]);

  useEffect(() => {
    if (isRemitModalOpen) {
      remitGuardRef.current = openGuard({ cancellable: true, label: 'Remit WHT payable' });
      return () => {
        if (remitGuardRef.current) {
          closeGuard(remitGuardRef.current.id);
          remitGuardRef.current = null;
        }
      };
    }
  }, [isRemitModalOpen, openGuard, closeGuard]);

  useEffect(() => {
    if (isRecoverModalOpen) {
      recoverGuardRef.current = openGuard({ cancellable: true, label: 'Recover WHT receivable' });
      return () => {
        if (recoverGuardRef.current) {
          closeGuard(recoverGuardRef.current.id);
          recoverGuardRef.current = null;
        }
      };
    }
  }, [isRecoverModalOpen, openGuard, closeGuard]);

  const handleCreate = async () => {
    if (!form.code.trim() || !form.name.trim()) return;
    if (!form.appliesToSuppliers && !form.appliesToCustomers) return;
    await createMutation.mutateAsync({
      code: form.code,
      name: form.name,
      rate: form.rate > 1 ? form.rate / 100 : form.rate,
      appliesTo:
        form.appliesToSuppliers && form.appliesToCustomers
          ? 'BOTH'
          : form.appliesToCustomers
            ? 'CUSTOMER'
            : 'SUPPLIER',
    });
    setForm(emptyTypeForm);
    setIsTypeModalOpen(false);
  };

  const handleRemit = async () => {
    const amount = Number(remitForm.amount);
    if (!(amount > 0) || !remitForm.reference.trim() || !remitForm.paymentAccountCode) return;
    await remitMutation.mutateAsync({
      amount,
      date: remitForm.date,
      reference: remitForm.reference.trim(),
      paymentAccountCode: remitForm.paymentAccountCode,
    });
    setRemitForm((prev) => ({
      amount: '',
      date: todayIso(),
      reference: '',
      paymentAccountCode: prev.paymentAccountCode,
    }));
    setIsRemitModalOpen(false);
  };

  const handleRecover = async () => {
    const amount = Number(recoverForm.amount);
    if (!(amount > 0) || !recoverForm.reference.trim() || !recoverForm.paymentAccountCode) return;
    await recoverMutation.mutateAsync({
      amount,
      date: recoverForm.date,
      reference: recoverForm.reference.trim(),
      paymentAccountCode: recoverForm.paymentAccountCode,
    });
    setRecoverForm((prev) => ({
      amount: '',
      date: todayIso(),
      reference: '',
      paymentAccountCode: prev.paymentAccountCode,
    }));
    setIsRecoverModalOpen(false);
  };

  const canCreateType =
    !!form.code.trim() &&
    !!form.name.trim() &&
    (form.appliesToSuppliers || form.appliesToCustomers) &&
    !createMutation.isPending;

  const canRemit =
    Number(remitForm.amount) > 0 &&
    !!remitForm.reference.trim() &&
    !!remitForm.paymentAccountCode &&
    !!remitForm.date &&
    !!(payable.balance && payable.balance > 0) &&
    !remitMutation.isPending;

  const canRecover =
    Number(recoverForm.amount) > 0 &&
    !!recoverForm.reference.trim() &&
    !!recoverForm.paymentAccountCode &&
    !!recoverForm.date &&
    !!(receivable.balance && receivable.balance > 0) &&
    !recoverMutation.isPending;

  useSubmitOnEnter(isTypeModalOpen, canCreateType, () => void handleCreate());
  useSubmitOnEnter(isRemitModalOpen, canRemit, () => void handleRemit());
  useSubmitOnEnter(isRecoverModalOpen, canRecover, () => void handleRecover());

  const fmt = (val?: number) =>
    typeof val === 'number' ? val.toLocaleString('en-US', { minimumFractionDigits: 0 }) : '0';

  return (
    <div className="p-4 sm:p-6 space-y-4 sm:space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Withholding Tax</h1>
          <p className="text-sm text-gray-500 mt-1">
            Manage WHT types, remit payable to URA, and recover Tax Receivable
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            to="/reports/tax-compliance"
            className="inline-flex items-center rounded-md font-medium px-4 py-2 border border-gray-300 text-gray-700 hover:bg-gray-50 text-sm"
          >
            <FileBarChart2 className="h-4 w-4 mr-2" />
            Tax reports
          </Link>
          <Button
            variant="outline"
            className="border-orange-300 text-orange-800 bg-orange-50 hover:bg-orange-100"
            onClick={() => setIsRemitModalOpen(true)}
          >
            <Landmark className="h-4 w-4 mr-2" />
            Remit Payable
          </Button>
          <Button
            variant="outline"
            className="border-sky-300 text-sky-800 bg-sky-50 hover:bg-sky-100"
            onClick={() => setIsRecoverModalOpen(true)}
          >
            <Banknote className="h-4 w-4 mr-2" />
            Recover Receivable
          </Button>
          <Button onClick={() => setIsTypeModalOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Add WHT Type
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>WHT Payable ({payable.accountCode || '2350'})</CardDescription>
            <CardTitle className="text-xl text-orange-600">{fmt(payable.balance)}</CardTitle>
          </CardHeader>
          <CardContent className="pt-0 text-xs text-gray-400">
            {payable.entries ?? 0} ledger txns
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Tax Receivable ({receivable.accountCode || '1250'})</CardDescription>
            <CardTitle className="text-xl text-sky-700">{fmt(receivable.balance)}</CardTitle>
          </CardHeader>
          <CardContent className="pt-0 text-xs text-gray-400">
            {receivable.entries ?? 0} ledger txns
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Configured Types</CardDescription>
            <CardTitle className="text-xl text-blue-600">{items.length}</CardTitle>
          </CardHeader>
          <CardContent className="pt-0 text-xs text-gray-400">
            {certificates.length} certificates issued
          </CardContent>
        </Card>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="w-full sm:w-auto flex overflow-x-auto">
          <TabsTrigger value="types" className="flex-shrink-0">
            <Receipt className="h-4 w-4 mr-1.5 sm:mr-2" />
            <span className="whitespace-nowrap">WHT Types</span>
          </TabsTrigger>
          <TabsTrigger value="certificates" className="flex-shrink-0">
            <ListOrdered className="h-4 w-4 mr-1.5 sm:mr-2" />
            <span className="whitespace-nowrap">Certificates</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="types">
          {isLoading ? (
            <div className="text-center py-12 text-gray-500">Loading…</div>
          ) : (
            <Card>
              <ResponsiveTableWrapper>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Code</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead className="text-right">Rate</TableHead>
                      <TableHead className="text-center">Applies To</TableHead>
                      <TableHead>Account</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center py-10 text-gray-500">
                          <Receipt className="h-8 w-8 mx-auto mb-2 text-gray-300" />
                          No WHT types configured.
                        </TableCell>
                      </TableRow>
                    ) : (
                      items.map((wht) => (
                        <TableRow key={wht.id}>
                          <TableCell className="font-medium">{wht.code}</TableCell>
                          <TableCell>{wht.name}</TableCell>
                          <TableCell className="text-right font-medium">
                            {(wht.rate * 100).toFixed(1)}%
                          </TableCell>
                          <TableCell className="text-center">
                            <Badge className="bg-blue-100 text-blue-700">{wht.appliesTo}</Badge>
                          </TableCell>
                          <TableCell className="text-gray-500">{wht.accountCode || '—'}</TableCell>
                          <TableCell>
                            <Badge
                              className={
                                wht.isActive
                                  ? 'bg-green-100 text-green-700'
                                  : 'bg-gray-100 text-gray-600'
                              }
                            >
                              {wht.isActive ? 'Active' : 'Inactive'}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </ResponsiveTableWrapper>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="certificates">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">WHT Certificates</CardTitle>
              <CardDescription>
                Auto-numbered <code className="text-xs">WHT-CERT-YYYY-####</code> on payment
                (override allowed)
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              <ResponsiveTableWrapper>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Certificate</TableHead>
                      <TableHead>Side</TableHead>
                      <TableHead>Party</TableHead>
                      <TableHead>Payment</TableHead>
                      <TableHead className="text-right">Base</TableHead>
                      <TableHead className="text-right">WHT</TableHead>
                      <TableHead className="text-right">Net</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {certificates.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7} className="text-center py-10 text-gray-500">
                          No certificates issued yet. Post a supplier or customer payment with WHT.
                        </TableCell>
                      </TableRow>
                    ) : (
                      certificates.map((cert) => (
                        <TableRow key={cert.id}>
                          <TableCell className="font-medium">{cert.certificateNumber}</TableCell>
                          <TableCell>
                            {cert.transactionType === 'CUSTOMER_PAYMENT' ? 'Customer' : 'Supplier'}
                          </TableCell>
                          <TableCell>{cert.partyName || '—'}</TableCell>
                          <TableCell className="text-gray-500">
                            {cert.paymentNumber || '—'}
                            {cert.paymentDate ? (
                              <span className="block text-xs text-gray-400">
                                {String(cert.paymentDate).slice(0, 10)}
                              </span>
                            ) : null}
                          </TableCell>
                          <TableCell className="text-right">{fmt(cert.baseAmount)}</TableCell>
                          <TableCell className="text-right font-medium">
                            {fmt(cert.whtAmount)}
                          </TableCell>
                          <TableCell className="text-right">{fmt(cert.netAmount)}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </ResponsiveTableWrapper>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Add WHT Type — same Dialog pattern as Expense Categories / Chart of Accounts */}
      <Dialog open={isTypeModalOpen} onOpenChange={setIsTypeModalOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New WHT Type</DialogTitle>
            <DialogDescription>
              Configure a withholding rate used at payment time (supplier and/or customer).
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <Label htmlFor="wht-code">Code</Label>
                <Input
                  id="wht-code"
                  value={form.code}
                  onChange={(e) => setForm({ ...form, code: e.target.value })}
                  placeholder="e.g., WHT-6"
                />
              </div>
              <div>
                <Label htmlFor="wht-rate">Rate (%)</Label>
                <Input
                  id="wht-rate"
                  type="number"
                  max={100}
                  step="1"
                  value={String(form.rate)}
                  onChange={(e) => setForm({ ...form, rate: parseFloat(e.target.value) || 0 })}
                />
              </div>
            </div>
            <div>
              <Label htmlFor="wht-name">Name</Label>
              <Input
                id="wht-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g., Service WHT 6%"
              />
            </div>
            <div className="flex flex-col sm:flex-row gap-4">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={form.appliesToSuppliers}
                  onCheckedChange={(checked) =>
                    setForm({ ...form, appliesToSuppliers: Boolean(checked) })
                  }
                />
                Applies to Suppliers
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={form.appliesToCustomers}
                  onCheckedChange={(checked) =>
                    setForm({ ...form, appliesToCustomers: Boolean(checked) })
                  }
                />
                Applies to Customers
              </label>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setForm(emptyTypeForm);
                setIsTypeModalOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button disabled={!canCreateType} onClick={() => void handleCreate()}>
              {createMutation.isPending ? 'Creating…' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remit — same Dialog + transaction guard pattern as Customer/Supplier Payments */}
      <Dialog
        open={isRemitModalOpen}
        onOpenChange={setIsRemitModalOpen}
        zIndex={remitGuardRef.current?.panelZIndex ?? ZINDEX.PANEL}
      >
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Remit WHT Payable</DialogTitle>
            <DialogDescription>
              DR {payable.accountCode || '2350'} / CR selected cash-bank — pay withheld tax to URA
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 py-2">
            <div>
              <Label htmlFor="remit-amount">Amount</Label>
              <Input
                id="remit-amount"
                type="number"
                step="1"
                value={remitForm.amount}
                onChange={(e) => setRemitForm({ ...remitForm, amount: e.target.value })}
                placeholder={`Max ${fmt(payable.balance)}`}
              />
            </div>
            <div>
              <Label>Date</Label>
              <DatePicker
                value={remitForm.date}
                onChange={(date) => setRemitForm({ ...remitForm, date })}
              />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="remit-ref">URA / payment reference</Label>
              <Input
                id="remit-ref"
                value={remitForm.reference}
                onChange={(e) => setRemitForm({ ...remitForm, reference: e.target.value })}
                placeholder="e.g. URA-PRN-2026-001"
              />
            </div>
            <div className="sm:col-span-2">
              <Label>Pay from account</Label>
              <Select
                value={remitForm.paymentAccountCode}
                onValueChange={(v) => setRemitForm({ ...remitForm, paymentAccountCode: v })}
                title="Pay from account"
              >
                <SelectContent>
                  {cashOptions.map((a) => (
                    <SelectItem key={a.id || a.code} value={a.code}>
                      {a.code} — {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setIsRemitModalOpen(false)}>
              Cancel
            </Button>
            <Button
              className="bg-orange-600 hover:bg-orange-700"
              disabled={!canRemit}
              onClick={() => void handleRemit()}
            >
              {remitMutation.isPending ? 'Posting…' : 'Post Remittance'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Recover receivable */}
      <Dialog
        open={isRecoverModalOpen}
        onOpenChange={setIsRecoverModalOpen}
        zIndex={recoverGuardRef.current?.panelZIndex ?? ZINDEX.PANEL}
      >
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Recover Tax Receivable</DialogTitle>
            <DialogDescription>
              DR selected cash-bank / CR {receivable.accountCode || '1250'} — customer WHT recovered
              from URA
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 py-2">
            <div>
              <Label htmlFor="recover-amount">Amount</Label>
              <Input
                id="recover-amount"
                type="number"
                step="1"
                value={recoverForm.amount}
                onChange={(e) => setRecoverForm({ ...recoverForm, amount: e.target.value })}
                placeholder={`Max ${fmt(receivable.balance)}`}
              />
            </div>
            <div>
              <Label>Date</Label>
              <DatePicker
                value={recoverForm.date}
                onChange={(date) => setRecoverForm({ ...recoverForm, date })}
              />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="recover-ref">URA / recovery reference</Label>
              <Input
                id="recover-ref"
                value={recoverForm.reference}
                onChange={(e) => setRecoverForm({ ...recoverForm, reference: e.target.value })}
                placeholder="e.g. URA-REFUND-2026-001"
              />
            </div>
            <div className="sm:col-span-2">
              <Label>Deposit to account</Label>
              <Select
                value={recoverForm.paymentAccountCode}
                onValueChange={(v) => setRecoverForm({ ...recoverForm, paymentAccountCode: v })}
                title="Deposit to account"
              >
                <SelectContent>
                  {cashOptions.map((a) => (
                    <SelectItem key={a.id || a.code} value={a.code}>
                      {a.code} — {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setIsRecoverModalOpen(false)}>
              Cancel
            </Button>
            <Button
              className="bg-sky-600 hover:bg-sky-700"
              disabled={!canRecover}
              onClick={() => void handleRecover()}
            >
              {recoverMutation.isPending ? 'Posting…' : 'Post Recovery'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}