'use strict';

/**
 * Reference data: the permission vocabulary, the roles built from it, the
 * admin-editable settings and the legal copy. Applied idempotently on every
 * migrate, so adding a permission here rolls it out without a hand-written
 * migration. Existing setting VALUES are never overwritten — only missing
 * keys are inserted — so an operator's edits survive a redeploy.
 */

const PERMISSIONS = [
  ['users.view', 'View user accounts, profiles and activity'],
  ['users.manage', 'Restrict, suspend, ban or restore user accounts'],
  ['users.notes', 'Add internal notes to a user account'],
  ['kyc.view', 'View submitted identity documents (masked)'],
  ['kyc.reveal', 'Reveal a full identity document number (logged every time)'],
  ['kyc.review', 'Approve or reject identity verification'],
  ['deposits.view', 'View deposit submissions and evidence'],
  ['deposits.review', 'Approve, reject or request more information on deposits'],
  ['withdrawals.view', 'View withdrawal requests'],
  ['withdrawals.review', 'Approve or reject withdrawal requests'],
  ['withdrawals.process', 'Mark withdrawals as processing or completed'],
  ['ledger.adjust', 'Post a manual balance adjustment (always audited)'],
  ['ledger.view', 'View the transaction ledger across accounts'],
  ['risk.view', 'View duplicate-account and risk flags'],
  ['risk.review', 'Resolve duplicate-account and risk flags'],
  ['support.view', 'View support requests'],
  ['support.respond', 'Reply to and close support requests'],
  ['settings.view', 'View platform configuration'],
  ['settings.manage', 'Change platform configuration'],
  ['payments.manage', 'Add or edit deposit and withdrawal payment methods'],
  ['content.manage', 'Edit homepage, risk disclosure and legal copy'],
  ['audit.view', 'Read the audit log'],
  ['admins.manage', 'Create and manage administrator accounts and roles'],
];

const ROLES = [
  {
    key: 'super_admin',
    name: 'Super Admin',
    description: 'Unrestricted access, including administrator management and audit history.',
    permissions: '*',
  },
  {
    key: 'finance_admin',
    name: 'Finance Admin',
    description: 'Deposits, withdrawals, ledger adjustments and financial reconciliation.',
    permissions: [
      'users.view', 'deposits.view', 'deposits.review', 'withdrawals.view', 'withdrawals.review',
      'withdrawals.process', 'ledger.adjust', 'ledger.view', 'risk.view', 'audit.view',
      'settings.view', 'payments.manage',
    ],
  },
  {
    key: 'support_admin',
    name: 'Support Admin',
    description: 'User assistance and support tickets. Read-only on anything financial.',
    permissions: [
      'users.view', 'users.notes', 'support.view', 'support.respond',
      'deposits.view', 'withdrawals.view', 'kyc.view', 'settings.view',
    ],
  },
  {
    key: 'verification_admin',
    name: 'Verification Admin',
    description: 'Identity verification, deposit evidence review and duplicate-account review.',
    permissions: [
      'users.view', 'kyc.view', 'kyc.review', 'deposits.view', 'deposits.review',
      'risk.view', 'risk.review', 'settings.view',
    ],
  },
];

// [key, value, type, group, label, help]
const SETTINGS = [
  // -- Investment programme ------------------------------------------------
  ['platform_name', 'Meridian FX', 'string', 'platform', 'Platform name', 'Shown in the header, page titles and emails.'],
  ['min_investment_cents', '3000', 'money', 'investment', 'Minimum investment', 'The smallest amount a user may commit, in cents.'],
  ['max_investment_cents', '1000000', 'money', 'investment', 'Maximum investment', 'The largest amount a user may commit, in cents.'],
  ['illus_divisor', '30', 'int', 'investment', 'Illustrative divisor', 'Daily illustrative figure = investment ÷ this number. 30 produces the $30 → $1.00/day example.'],
  ['illus_cycle_days', '24', 'int', 'investment', 'Illustrative cycle length (days)', 'Number of market days used for the example monthly figure.'],
  ['illus_disclaimer', 'This is an illustrative calculation based on a fixed arithmetic model chosen by the platform. It is not a forecast and not a guarantee. Actual forex results may be lower, higher, or negative.', 'text', 'investment', 'Illustrative calculation disclaimer', 'Displayed everywhere an illustrative figure appears.'],

  // -- Deposits ------------------------------------------------------------
  ['deposits_enabled', '1', 'bool', 'deposits', 'Accept new deposits', 'Turn off to stop new deposit submissions.'],
  ['deposit_instructions', 'Send the exact amount to the account shown above using EasyPaisa, then submit this form with your transaction ID and a screenshot of the confirmation. Deposits are credited only after our team verifies the payment against our receiving account records.', 'text', 'deposits', 'Deposit instructions', 'Shown on the deposit page above the form.'],
  ['deposit_review_sla_hours', '24', 'int', 'deposits', 'Stated review time (hours)', 'The turnaround shown to users. Set it to what your team actually achieves.'],

  // -- Withdrawals ---------------------------------------------------------
  ['withdrawals_enabled', '1', 'bool', 'withdrawals', 'Accept withdrawal requests', 'Turn off to stop new withdrawal requests.'],
  ['withdrawal_min_cents', '1000', 'money', 'withdrawals', 'Minimum withdrawal', 'The smallest withdrawal a user may request, in cents.'],
  ['withdrawal_fee_bps', '0', 'int', 'withdrawals', 'Withdrawal fee (basis points)', '100 basis points = 1%. Set 0 for no fee.'],
  ['withdrawal_rules', 'Withdrawals are paid to an account in your own name. Requests are reviewed by our finance team during working hours. The requested amount is placed on hold as soon as you submit, and returned to your available balance if the request is rejected or cancelled.', 'text', 'withdrawals', 'Withdrawal rules', 'Shown on the withdrawal page.'],
  ['withdrawal_whatsapp_enabled', '1', 'bool', 'withdrawals', 'Offer WhatsApp withdrawal submission', 'Shows a WhatsApp shortcut that pre-fills the request details.'],

  // -- Support -------------------------------------------------------------
  ['support_whatsapp', '03422253628', 'string', 'support', 'WhatsApp support number', 'Used for every WhatsApp contact link on the platform.'],
  ['support_hours', '9:00 AM – 12:05 AM (PKT)', 'string', 'support', 'Human support hours', 'State the hours your team genuinely answers. Do not claim 24/7 unless it is staffed 24/7.'],
  ['support_email', '', 'string', 'support', 'Support email address', 'Optional. Left blank, the email contact is hidden rather than shown as a dead link.'],

  // -- Verification & risk -------------------------------------------------
  ['kyc_required', '0', 'bool', 'compliance', 'Require identity verification', 'When on, users must submit identity documents before withdrawing.'],
  ['kyc_retention_months', '60', 'int', 'compliance', 'Identity document retention (months)', 'How long identity records are kept after submission before they are due for deletion.'],
  ['kyc_purpose_note', 'Your identity document is collected to confirm you are the account holder, to satisfy anti-money-laundering obligations, and to prevent one person operating multiple accounts. It is encrypted at rest, only the last digit is shown in dashboards, and every access is logged.', 'text', 'compliance', 'Why we collect identity documents', 'Shown next to the consent checkbox. Must accurately describe your actual use.'],
  ['duplicate_review_enabled', '1', 'bool', 'compliance', 'Flag suspected duplicate accounts for review', 'Raises a flag for a human to review. Never auto-bans.'],

  // -- Notifications -------------------------------------------------------
  ['sms_notifications_enabled', '0', 'bool', 'notifications', 'Send SMS notifications', 'Requires an SMS provider to be configured in the environment. Off by default.'],

  // -- Platform state ------------------------------------------------------
  ['registration_enabled', '1', 'bool', 'platform', 'Allow new registrations', 'Turn off to close signups.'],
  ['maintenance_mode', '0', 'bool', 'platform', 'Maintenance mode', 'Users see a maintenance page. Administrators can still sign in.'],
  ['maintenance_message', 'We are carrying out scheduled maintenance and will be back shortly.', 'text', 'platform', 'Maintenance message', 'Shown while maintenance mode is on.'],
  ['terms_version', '2026-01', 'string', 'platform', 'Terms version', 'Recorded against each registration. Bump it when the terms change materially.'],
];

const CONTENT = [
  {
    key: 'hero_headline',
    title: 'Homepage headline',
    body: 'A forex investment account with every figure you can check.',
  },
  {
    key: 'hero_subhead',
    title: 'Homepage subheading',
    body: 'Open an account from $30. Fund it, see exactly what has been verified and what is still pending, and request a withdrawal when you want your money. Forex trading carries substantial risk, including the loss of your capital.',
  },
  {
    key: 'why_platform',
    title: 'Why this platform',
    body: JSON.stringify([
      { title: 'Verified deposits only', body: 'A screenshot starts a review; it never credits your balance on its own. Funds appear once our team has matched the payment against our receiving account records.' },
      { title: 'A ledger, not a number', body: 'Every credit and debit is a permanent, referenced entry. Your balance is the sum of those entries, so any figure you see can be traced back to the movement that produced it.' },
      { title: 'Illustrative figures labelled as such', body: 'The calculator shows what the platform’s example model produces for an amount. It is arithmetic, clearly marked, and never presented as a return you will receive.' },
      { title: 'One account per person', body: 'Duplicate signups are flagged for a human to review rather than silently banned, so a shared device does not cost a legitimate user their account.' },
      { title: 'Identity data kept minimal', body: 'If you submit an identity document it is encrypted at rest, masked everywhere it is displayed, and every access by staff is recorded in an audit log.' },
      { title: 'Support you can reach', body: 'WhatsApp support during published hours, and an in-app ticket that keeps the full history of your conversation attached to your account.' },
    ]),
  },
  {
    key: 'risk_disclosure',
    title: 'Risk Disclosure',
    body: `## Forex risk warning

Forex trading involves substantial risk and may result in the loss of some or all of your invested capital. Past performance does not guarantee future results. Any returns, calculations, projections, or examples displayed on this platform are illustrative and are not guaranteed. Only invest funds you can afford to lose.

## What the illustrative calculator is

The calculator on this platform applies a fixed arithmetic model chosen by the operator: the daily figure is the investment amount divided by a configured number, and the cycle figure applies that daily figure across a configured number of market days.

It is a worked example of that model. It is not a forecast, not a projection of market performance, and not a commitment to pay. Actual results may be lower, higher, or negative.

## What we do not claim

This platform makes no claim of guaranteed profit, fixed income, risk-free returns, or protection from loss. It does not publish trading performance, and it does not claim any regulatory authorisation, broker relationship or licence that it has not been granted.

## Your capital is at risk

Money committed to a forex programme can fall in value. You may get back less than you put in, and you may lose the entire amount. Do not invest borrowed money, money you need for living costs, or money you cannot afford to lose.

## Before you invest

Consider whether you understand how forex works and whether you can afford to take the risk. If you are unsure, seek independent financial advice. Nothing on this platform is personal financial advice.`,
  },
  {
    key: 'terms',
    title: 'Terms & Conditions',
    body: `## 1. Account

You may hold one account. It must be in your own legal name, with a phone number you control. Accounts opened with another person's details, or additional accounts held by the same person, may be restricted or closed.

## 2. Accuracy of information

You are responsible for the accuracy of the details you submit, including your phone number, payment references and payout account. Payments sent to or from details that do not match your account may be delayed while we verify them.

## 3. Deposits

A deposit is credited only after our team verifies it against our receiving account records. Submitting a screenshot or a transaction reference does not credit your balance. We may reject a deposit we cannot verify, and we may ask you for further information.

## 4. Withdrawals

Withdrawals are paid to an account in your own name. The amount requested is placed on hold at the moment you submit the request and is returned to your available balance if the request is rejected or cancelled. Processing times depend on the payment provider and our review queue.

## 5. Risk

Forex trading carries substantial risk. You may lose some or all of the money you commit. Illustrative figures shown anywhere on this platform are examples of an arithmetic model, not guaranteed returns.

## 6. Suspension and closure

We may restrict or suspend an account where we reasonably suspect fraud, duplicate registration, misuse, or a breach of these terms. Where an account is restricted you retain access to your records and may contact support.

## 7. Changes

We may change these terms. Material changes are published with a new version identifier, and continued use of the platform after that point constitutes acceptance.`,
  },
  {
    key: 'privacy',
    title: 'Privacy Policy',
    body: `## What we collect

Your name, email address, phone number, and the payment details you submit with a deposit or withdrawal. If identity verification is enabled for your account, the identity document you provide. We also record technical signals about the device and network you sign in from.

## Why we collect it

To operate your account, to verify payments against our receiving records, to meet anti-money-laundering obligations, and to detect one person operating multiple accounts.

## How identity data is held

Identity document numbers are encrypted at rest with AES-256-GCM. Dashboards show a masked value only. Access by staff is limited by role and every access is written to an append-only audit log.

## Device and network signals

We record a device identifier derived from your browser's characteristics, along with the IP address of your requests. These signals are indicative: they can match between different people and can change for the same person. They are used to raise a case for human review, never to make an automatic decision against you on their own.

## Retention

Account and transaction records are retained for as long as the account exists and for the period required afterwards by applicable financial record-keeping rules. Identity documents are retained for the period configured by the operator and are due for deletion after it.

## Your requests

To ask what we hold about you, to correct it, or to request deletion where we are not required to retain it, contact support through the platform.`,
  },
  {
    key: 'program_terms',
    title: 'Investment Programme Terms',
    body: `## Amounts

The minimum and maximum investment are set by the operator and shown on the investment page at the time you commit. The amount you commit is debited from your available balance and held as principal for the duration of the investment.

## The illustrative model

The platform displays an example figure derived from a fixed divisor and a cycle length in market days, both configured by the operator. The example in force when you open an investment is recorded against that investment so a later change to the settings does not rewrite what you were shown.

This figure is arithmetic, not a forecast. It does not represent a return you are entitled to, and it is not credited to your balance automatically.

## How profit is credited

Realised profit, if any, is credited to your balance as a ledger entry posted by an authorised member of staff, with an audit record naming who posted it and why. Your dashboard separates realised profit — money actually credited — from the illustrative figure, and never adds an illustrative figure to your balance.

## Losses

Forex trading can produce a loss. A loss may reduce the principal returned to you at the end of an investment. You may receive back less than you committed.

## Closing an investment

When an investment is closed, the principal recorded against it is returned to your available balance, adjusted for any realised outcome, as a traceable ledger entry.`,
  },
  {
    key: 'how_it_works_note',
    title: 'How it works — closing note',
    body: 'Nothing on this page is a promise of profit. The figures shown are a worked example of the platform’s arithmetic model, and actual forex results may be lower, higher, or negative.',
  },
];

const PAYMENT_METHODS = [
  {
    key: 'easypaisa',
    name: 'EasyPaisa',
    provider: 'easypaisa',
    account_title: 'Account title as configured by the administrator',
    account_number: '03434650601',
    instructions: 'Open EasyPaisa, choose Send Money, and send the exact amount to the number above. Keep the confirmation screen — you will need the transaction ID.',
    for_deposit: 1,
    for_withdrawal: 1,
    sort_order: 1,
  },
  {
    key: 'jazzcash',
    name: 'JazzCash',
    provider: 'jazzcash',
    account_title: '',
    account_number: '',
    instructions: 'Not configured. Add the receiving account details in the admin panel before enabling this method.',
    for_deposit: 1,
    for_withdrawal: 1,
    sort_order: 2,
    is_active: 0,
  },
  {
    key: 'bank_transfer',
    name: 'Bank transfer',
    provider: 'bank',
    account_title: '',
    account_number: '',
    instructions: 'Not configured. Add the receiving account details in the admin panel before enabling this method.',
    for_deposit: 1,
    for_withdrawal: 1,
    sort_order: 3,
    is_active: 0,
  },
];

module.exports = { PERMISSIONS, ROLES, SETTINGS, CONTENT, PAYMENT_METHODS };
