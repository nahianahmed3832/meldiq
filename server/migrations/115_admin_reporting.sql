-- Additive indexes for provider/currency reporting and stable filtered webhook drill-downs.
CREATE INDEX IF NOT EXISTS idx_billing_events_provider_status_received ON billing_provider_events(provider, status, received_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_billing_invoices_provider_currency_paid ON billing_invoices(provider, currency, paid_at);
CREATE INDEX IF NOT EXISTS idx_billing_subscriptions_provider_created ON billing_subscriptions(provider, created_at);
