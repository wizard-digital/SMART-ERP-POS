import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Landmark } from 'lucide-react';
import { api } from '../../utils/api';
import { ResponsiveTableWrapper } from '../../components/ui/ResponsiveTableWrapper';
import { useBackendPermission } from '../../hooks/useBackendPermission';
import { toastApiError } from '../../utils/errorHandler';
import toast from 'react-hot-toast';

type Profile = {
  legalForm: 'SOLE_PROPRIETOR' | 'COMPANY';
  accounts: Array<{ code: string; name: string; posting: boolean }>;
  blockers?: string[];
};

type Shareholder = { id: string; legal_name: string; user_id: string | null; customer_id: string | null };
type Slice = { shareholderId: string; shares: string; percent: string };
type Register = {
  asOf: string;
  ownership: Slice[];
  events: Array<{
    event_type: string;
    effective_date: string;
    quantity: string;
    from_shareholder_id: string | null;
    to_shareholder_id: string | null;
    reference: string | null;
  }>;
};

const tabs = ['Holders', 'Holdings', 'History', 'Issues', 'Transfers', 'Dividends', 'Loans'] as const;

function unwrap<T>(payload: { data?: { data?: T } }): T {
  return (payload.data?.data ?? payload.data) as T;
}

export default function OwnershipEquityPage() {
  const queryClient = useQueryClient();
  const canManage = useBackendPermission('ownership.manage');
  const canIssue = useBackendPermission('ownership.issue');
  const canTransfer = useBackendPermission('ownership.transfer');
  const canApprove = useBackendPermission('ownership.dividend_approve');
  const profile = useQuery({
    queryKey: ['ownership', 'profile'],
    queryFn: async () => unwrap<Profile>(await api.ownership.profile()),
  });
  const [tab, setTab] = useState<(typeof tabs)[number]>('Holders');
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));
  const [legalName, setLegalName] = useState('');
  const company = profile.data?.legalForm === 'COMPANY';

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['ownership'] });
  const setForm = useMutation({
    mutationFn: (legalForm: 'SOLE_PROPRIETOR' | 'COMPANY') => api.ownership.setLegalForm(legalForm),
    onSuccess: () => {
      toast.success('Legal form saved. No journal was posted.');
      refresh();
    },
    onError: (error) => toastApiError(error),
  });

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <Landmark className="h-6 w-6 text-blue-600" />
          Ownership & Equity
        </h1>
        <p className="text-gray-500 mt-1">
          Owner capital stays on account 3200. Company shares use a separate register and share capital 3400.
        </p>
      </div>

      {profile.data && (
        <div className="bg-white rounded-lg shadow p-4 space-y-3">
          <p className="text-sm text-gray-700">
            Legal form: <strong>{profile.data.legalForm === 'COMPANY' ? 'Company' : 'Sole proprietor'}</strong>
          </p>
          {canManage && (
            <button
              type="button"
              className="px-3 py-2 text-sm border rounded-md disabled:opacity-50"
              disabled={setForm.isPending}
              onClick={() => setForm.mutate(company ? 'SOLE_PROPRIETOR' : 'COMPANY')}
            >
              {company ? 'Set sole proprietor' : 'Set company'}
            </button>
          )}
          {company && (profile.data.blockers?.length ?? 0) > 0 && (
            <div className="text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-md p-3">
              <p>Clear the following before the legal form can return to sole proprietor:</p>
              <ul className="list-disc pl-5 mt-1">
                {profile.data.blockers!.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            </div>
          )}
          <ResponsiveTableWrapper>
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500">
                  <th className="py-2 pr-4">Code</th>
                  <th className="py-2 pr-4">Name</th>
                  <th className="py-2">Posting</th>
                </tr>
              </thead>
              <tbody>
                {profile.data.accounts.map((account) => (
                  <tr key={account.code} className="border-t">
                    <td className="py-2 pr-4">{account.code}</td>
                    <td className="py-2 pr-4">{account.name}</td>
                    <td className="py-2">{account.posting ? 'Yes' : 'Header'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ResponsiveTableWrapper>
        </div>
      )}

      {!company && (
        <div className="bg-white rounded-lg shadow p-4 text-sm text-gray-700 space-y-2">
          <p>Owner contributions stay: debit cash, credit 3200 Owner Capital.</p>
          <p>Owner drawings stay: debit 3300 Owner Drawings, credit cash.</p>
          <p>Share issue, transfer, dividend, and shareholder-loan actions stay hidden until an authorized user sets the legal form to company.</p>
          <Link className="text-blue-600" to="/accounting/journal-entries">Open journal entries</Link>
        </div>
      )}

      {company && (
        <>
          <div className="flex flex-wrap gap-2">
            {tabs.map((name) => (
              <button
                key={name}
                type="button"
                className={`px-3 py-2 text-sm rounded-md border ${tab === name ? 'bg-blue-600 text-white' : 'bg-white'}`}
                onClick={() => setTab(name)}
              >
                {name}
              </button>
            ))}
          </div>
          {tab === 'Holders' && (
            <Holders
              canManage={canManage}
              legalName={legalName}
              setLegalName={setLegalName}
              onCreated={refresh}
            />
          )}
          {(tab === 'Holdings' || tab === 'History') && (
            <RegisterView asOf={asOf} setAsOf={setAsOf} history={tab === 'History'} />
          )}
          {tab === 'Issues' && <IssueForm canIssue={canIssue} />}
          {tab === 'Transfers' && <TransferForm canTransfer={canTransfer} />}
          {tab === 'Dividends' && <DividendPanel canManage={canManage} canApprove={canApprove} />}
          {tab === 'Loans' && <LoanPanel canManage={canManage} />}
        </>
      )}
    </div>
  );
}

function Holders({
  canManage,
  legalName,
  setLegalName,
  onCreated,
}: {
  canManage: boolean;
  legalName: string;
  setLegalName: (value: string) => void;
  onCreated: () => void;
}) {
  const holders = useQuery({
    queryKey: ['ownership', 'holders'],
    queryFn: async () => unwrap<Shareholder[]>(await api.ownership.shareholders()),
  });
  const create = useMutation({
    mutationFn: () => api.ownership.createShareholder({ legalName }),
    onSuccess: () => {
      setLegalName('');
      onCreated();
      toast.success('Shareholder saved');
    },
    onError: (error) => toastApiError(error),
  });
  return (
    <div className="bg-white rounded-lg shadow p-4 space-y-3">
      <p className="text-sm text-gray-600">Legal name is stored here. Phone, email, and address stay on the linked user or customer when one is chosen later.</p>
      {canManage && (
        <form
          className="flex flex-col sm:flex-row gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <input className="border rounded-md px-3 py-2 text-sm flex-1" value={legalName} onChange={(event) => setLegalName(event.target.value)} placeholder="Legal name" required />
          <button className="px-3 py-2 text-sm bg-blue-600 text-white rounded-md disabled:opacity-50" type="submit" disabled={create.isPending}>Add holder</button>
        </form>
      )}
      <ResponsiveTableWrapper>
        <table className="min-w-full text-sm">
          <tbody>
            {(holders.data ?? []).map((holder) => (
              <tr key={holder.id} className="border-t">
                <td className="py-2">{holder.legal_name}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ResponsiveTableWrapper>
    </div>
  );
}

function RegisterView({ asOf, setAsOf, history }: { asOf: string; setAsOf: (value: string) => void; history: boolean }) {
  const register = useQuery({
    queryKey: ['ownership', 'register', asOf],
    queryFn: async () => unwrap<Register>(await api.ownership.register(asOf)),
  });
  const names = useQuery({
    queryKey: ['ownership', 'holders'],
    queryFn: async () => unwrap<Shareholder[]>(await api.ownership.shareholders()),
  });
  const nameOf = (id: string | null) => names.data?.find((row) => row.id === id)?.legal_name ?? id ?? '';
  return (
    <div className="bg-white rounded-lg shadow p-4 space-y-3">
      <label className="text-sm text-gray-700 flex flex-col sm:flex-row sm:items-center gap-2">
        As of
        <input className="border rounded-md px-3 py-2 text-sm" type="date" value={asOf} onChange={(event) => setAsOf(event.target.value)} />
      </label>
      {!history && (
        <ResponsiveTableWrapper>
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500">
                <th className="py-2">Shareholder</th>
                <th className="py-2">Ordinary shares</th>
                <th className="py-2">Ownership %</th>
              </tr>
            </thead>
            <tbody>
              {(register.data?.ownership ?? []).map((row) => (
                <tr key={row.shareholderId} className="border-t">
                  <td className="py-2">{nameOf(row.shareholderId)}</td>
                  <td className="py-2">{row.shares}</td>
                  <td className="py-2">{row.percent}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ResponsiveTableWrapper>
      )}
      {history && (
        <ResponsiveTableWrapper>
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500">
                <th className="py-2">Date</th>
                <th className="py-2">Event</th>
                <th className="py-2">From</th>
                <th className="py-2">To</th>
                <th className="py-2">Quantity</th>
              </tr>
            </thead>
            <tbody>
              {(register.data?.events ?? []).map((row, index) => (
                <tr key={`${row.effective_date}-${index}`} className="border-t">
                  <td className="py-2">{row.effective_date}</td>
                  <td className="py-2">{row.event_type}</td>
                  <td className="py-2">{nameOf(row.from_shareholder_id)}</td>
                  <td className="py-2">{nameOf(row.to_shareholder_id)}</td>
                  <td className="py-2">{row.quantity}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ResponsiveTableWrapper>
      )}
    </div>
  );
}

function IssueForm({ canIssue }: { canIssue: boolean }) {
  const holders = useQuery({ queryKey: ['ownership', 'holders'], queryFn: async () => unwrap<Shareholder[]>(await api.ownership.shareholders()) });
  const accounts = useQuery({ queryKey: ['ownership', 'cash'], queryFn: async () => unwrap<Array<{ code: string; name: string }>>(await api.ownership.liquidity()) });
  const [shareholderId, setShareholderId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [issueDate, setIssueDate] = useState(new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState('0.00');
  const [cash, setCash] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const queryClient = useQueryClient();
  const issue = useMutation({
    mutationFn: () =>
      api.ownership.issue({
        shareholderId,
        quantity,
        issueDate,
        considerationAmount: amount,
        considerationAccountCode: cash || null,
        idempotencyKey,
      }),
    onSuccess: () => {
      setIdempotencyKey(crypto.randomUUID());
      toast.success('Shares issued');
      queryClient.invalidateQueries({ queryKey: ['ownership'] });
    },
    onError: (error) => toastApiError(error),
  });
  if (!canIssue) return <p className="text-sm text-gray-600">You can view issues. Issuing shares needs ownership.issue and accounting.post.</p>;
  return (
    <form
      className="bg-white rounded-lg shadow p-4 grid gap-3 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        issue.mutate();
      }}
    >
      <select className="border rounded-md px-3 py-2 text-sm" value={shareholderId} onChange={(event) => setShareholderId(event.target.value)} required>
        <option value="">Shareholder</option>
        {(holders.data ?? []).map((holder) => (
          <option key={holder.id} value={holder.id}>{holder.legal_name}</option>
        ))}
      </select>
      <input className="border rounded-md px-3 py-2 text-sm" value={quantity} onChange={(event) => setQuantity(event.target.value)} placeholder="Quantity" required />
      <input className="border rounded-md px-3 py-2 text-sm" type="date" value={issueDate} onChange={(event) => setIssueDate(event.target.value)} required />
      <input className="border rounded-md px-3 py-2 text-sm" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="Consideration" required />
      <select className="border rounded-md px-3 py-2 text-sm" value={cash} onChange={(event) => setCash(event.target.value)}>
        <option value="">No cash received</option>
        {(accounts.data ?? []).map((account) => (
          <option key={account.code} value={account.code}>{account.code} {account.name}</option>
        ))}
      </select>
      <button className="px-3 py-2 text-sm bg-blue-600 text-white rounded-md disabled:opacity-50" type="submit" disabled={issue.isPending || (Number(amount) > 0 && !cash)}>Issue ordinary shares</button>
    </form>
  );
}

function TransferForm({ canTransfer }: { canTransfer: boolean }) {
  const holders = useQuery({ queryKey: ['ownership', 'holders'], queryFn: async () => unwrap<Shareholder[]>(await api.ownership.shareholders()) });
  const [fromShareholderId, setFrom] = useState('');
  const [toShareholderId, setTo] = useState('');
  const [quantity, setQuantity] = useState('');
  const [transferDate, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const queryClient = useQueryClient();
  const transfer = useMutation({
    mutationFn: () =>
      api.ownership.transfer({
        fromShareholderId,
        toShareholderId,
        quantity,
        transferDate,
        reason,
        idempotencyKey,
      }),
    onSuccess: () => {
      setIdempotencyKey(crypto.randomUUID());
      toast.success('Transfer recorded. No company journal was posted.');
      queryClient.invalidateQueries({ queryKey: ['ownership'] });
    },
    onError: (error) => toastApiError(error),
  });
  if (!canTransfer) return <p className="text-sm text-gray-600">Recording a transfer needs ownership.transfer.</p>;
  return (
    <form
      className="bg-white rounded-lg shadow p-4 grid gap-3 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        transfer.mutate();
      }}
    >
      <select className="border rounded-md px-3 py-2 text-sm" value={fromShareholderId} onChange={(event) => setFrom(event.target.value)} required>
        <option value="">From</option>
        {(holders.data ?? []).map((holder) => <option key={holder.id} value={holder.id}>{holder.legal_name}</option>)}
      </select>
      <select className="border rounded-md px-3 py-2 text-sm" value={toShareholderId} onChange={(event) => setTo(event.target.value)} required>
        <option value="">To</option>
        {(holders.data ?? []).map((holder) => <option key={holder.id} value={holder.id}>{holder.legal_name}</option>)}
      </select>
      <input className="border rounded-md px-3 py-2 text-sm" value={quantity} onChange={(event) => setQuantity(event.target.value)} placeholder="Quantity" required />
      <input className="border rounded-md px-3 py-2 text-sm" type="date" value={transferDate} onChange={(event) => setDate(event.target.value)} required />
      <input className="border rounded-md px-3 py-2 text-sm sm:col-span-2" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Reason or reference" />
      <button className="px-3 py-2 text-sm bg-blue-600 text-white rounded-md disabled:opacity-50" type="submit" disabled={transfer.isPending}>Record private transfer</button>
    </form>
  );
}

function DividendPanel({ canManage, canApprove }: { canManage: boolean; canApprove: boolean }) {
  const queryClient = useQueryClient();
  const rows = useQuery({
    queryKey: ['ownership', 'dividends'],
    queryFn: async () => unwrap<Array<{ id: string; amount: string; status: string }>>(await api.ownership.dividends()),
  });
  const accounts = useQuery({ queryKey: ['ownership', 'cash'], queryFn: async () => unwrap<Array<{ code: string; name: string }>>(await api.ownership.liquidity()) });
  const [amount, setAmount] = useState('');
  const [cash, setCash] = useState('');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const pendingRef = useRef<string | null>(null);
  const runRow = async (id: string, action: () => Promise<unknown>) => {
    if (pendingRef.current) return;
    pendingRef.current = id;
    setPendingId(id);
    try {
      await action();
      await queryClient.invalidateQueries({ queryKey: ['ownership', 'dividends'] });
    } catch (error) {
      toastApiError(error);
    } finally {
      pendingRef.current = null;
      setPendingId(null);
    }
  };
  const propose = useMutation({
    mutationFn: () => api.ownership.proposeDividend(amount),
    onSuccess: () => {
      toast.success('Proposal saved. No journal was posted.');
      queryClient.invalidateQueries({ queryKey: ['ownership', 'dividends'] });
    },
    onError: (error) => toastApiError(error),
  });
  return (
    <div className="bg-white rounded-lg shadow p-4 space-y-3 text-sm">
      <p>A proposal and an approval do not post. Declaration debits retained earnings 3100 and credits dividends payable 2450. Payment clears that payable.</p>
      <p>Dividend declaration is limited by the available posted 3100 Retained Earnings balance under the current accounting model.</p>
      {canManage && (
        <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); propose.mutate(); }}>
          <input className="border rounded-md px-3 py-2" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="Amount" required />
          <button className="px-3 py-2 bg-blue-600 text-white rounded-md disabled:opacity-50" type="submit" disabled={propose.isPending}>Propose</button>
        </form>
      )}
      <select className="border rounded-md px-3 py-2" value={cash} onChange={(event) => setCash(event.target.value)}>
        <option value="">Payment account</option>
        {(accounts.data ?? []).map((account) => <option key={account.code} value={account.code}>{account.code} {account.name}</option>)}
      </select>
      <ResponsiveTableWrapper>
        <table className="min-w-full">
          <tbody>
            {(rows.data ?? []).map((row) => (
              <tr key={row.id} className="border-t">
                <td className="py-2">{row.amount}</td>
                <td className="py-2">{row.status}</td>
                <td className="py-2 space-x-2">
                  {canApprove && row.status === 'PROPOSED' && (
                    <button type="button" className="underline disabled:opacity-50" disabled={pendingId === row.id} onClick={() => runRow(row.id, () => api.ownership.approveDividend(row.id))}>Approve</button>
                  )}
                  {canApprove && row.status === 'APPROVED' && (
                    <button type="button" className="underline disabled:opacity-50" disabled={pendingId === row.id} onClick={() => runRow(row.id, () => api.ownership.declareDividend(row.id, { declarationDate: new Date().toISOString().slice(0, 10), idempotencyKey: `div-dec-${row.id}` }))}>Declare</button>
                  )}
                  {canApprove && row.status === 'DECLARED' && cash && (
                    <button type="button" className="underline disabled:opacity-50" disabled={pendingId === row.id} onClick={() => runRow(row.id, () => api.ownership.payDividend(row.id, { paymentDate: new Date().toISOString().slice(0, 10), cashAccountCode: cash, idempotencyKey: `div-pay-${row.id}` }))}>Pay</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ResponsiveTableWrapper>
    </div>
  );
}

function LoanPanel({ canManage }: { canManage: boolean }) {
  const queryClient = useQueryClient();
  const data = useQuery({
    queryKey: ['ownership', 'loans'],
    queryFn: async () => unwrap<{ loans: Array<{ id: string; legal_name: string; principal_amount: string; status: string }>; glCreditBalance: string }>(await api.ownership.loans()),
  });
  const holders = useQuery({ queryKey: ['ownership', 'holders'], queryFn: async () => unwrap<Shareholder[]>(await api.ownership.shareholders()) });
  const accounts = useQuery({ queryKey: ['ownership', 'cash'], queryFn: async () => unwrap<Array<{ code: string; name: string }>>(await api.ownership.liquidity()) });
  const [shareholderId, setShareholderId] = useState('');
  const [amount, setAmount] = useState('');
  const [cash, setCash] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const draw = useMutation({
    mutationFn: () => api.ownership.drawLoan({ shareholderId, amount, cashAccountCode: cash, idempotencyKey }),
    onSuccess: () => {
      setIdempotencyKey(crypto.randomUUID());
      toast.success('Loan posted to 2600. Shares and 3200 were not changed.');
      queryClient.invalidateQueries({ queryKey: ['ownership'] });
    },
    onError: (error) => toastApiError(error),
  });
  return (
    <div className="bg-white rounded-lg shadow p-4 space-y-3 text-sm">
      <p>GL shareholder-loan balance (2600): {data.data?.glCreditBalance ?? '0'}</p>
      {canManage && (
        <form className="grid gap-2 sm:grid-cols-2" onSubmit={(event) => { event.preventDefault(); draw.mutate(); }}>
          <select className="border rounded-md px-3 py-2" value={shareholderId} onChange={(event) => setShareholderId(event.target.value)} required>
            <option value="">Shareholder</option>
            {(holders.data ?? []).map((holder) => <option key={holder.id} value={holder.id}>{holder.legal_name}</option>)}
          </select>
          <input className="border rounded-md px-3 py-2" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="Amount" required />
          <select className="border rounded-md px-3 py-2" value={cash} onChange={(event) => setCash(event.target.value)} required>
            <option value="">Cash or bank</option>
            {(accounts.data ?? []).map((account) => <option key={account.code} value={account.code}>{account.code} {account.name}</option>)}
          </select>
          <button className="px-3 py-2 bg-blue-600 text-white rounded-md disabled:opacity-50" type="submit" disabled={draw.isPending}>Record loan</button>
        </form>
      )}
      <ResponsiveTableWrapper>
        <table className="min-w-full">
          <tbody>
            {(data.data?.loans ?? []).map((loan) => (
              <tr key={loan.id} className="border-t">
                <td className="py-2">{loan.legal_name}</td>
                <td className="py-2">{loan.principal_amount}</td>
                <td className="py-2">{loan.status}</td>
                {canManage && loan.status === 'OPEN' && (
                  <td>
                    <button type="button" className="underline" onClick={() => api.ownership.repayLoan(loan.id, `loan-repay-${loan.id}`).then(() => queryClient.invalidateQueries({ queryKey: ['ownership'] })).catch(toastApiError)}>Repay</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </ResponsiveTableWrapper>
    </div>
  );
}
