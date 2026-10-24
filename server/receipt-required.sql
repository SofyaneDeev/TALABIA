-- Applied 2026-10-24: new payment requests must include a receipt photo
alter table public.pay_requests add constraint pay_requests_receipt_required check (receipt_path <> '') not valid;
