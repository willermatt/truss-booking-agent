/**
 * What the driver knows about Spectora's public Online Scheduler. Element IDs and test hooks were
 * observed on the live page on 2026-10-24 (Phase 0) and endpoint paths, button IDs, dialog texts and the
 * Review layout were read from the page's own script on 2026-10-25, without interacting with the form.
 * Items marked UNVERIFIED have not been seen rendered and are confirmed by the live dry run (Steps 1–3)
 * and the one designated test booking (Step 4).
 */
export const OFFICIAL_SCHEDULER_URL = 'https://app.spectora.com/home-inspectors/truss-home-inspections/schedule';
export const OFFICIAL_HOST = 'app.spectora.com';

export const SEL = {
  step1: '#scheduler-select-service',
  servicesSelect: '[data-testid=os-scheduler-services-select]',
  addOnSelect: '[data-testid=os-scheduler-addon-select]',
  serviceCheckboxes: '[id^="service-checkbox__"]',
  addOnCheckboxes: '[id^="service-addon-checkbox__"]',
  addressSearch: '#property-address-search',
  /** UNVERIFIED: suggestion rows. Google Places widget rows, or a listbox's options. */
  addressSuggestion: '.pac-container .pac-item, [role=listbox] [role=option]',
  street: '#address-address',
  unit: '#address-unity', // sic
  city: '#address-city',
  state: '#address-state',
  zip: '#address-zip',
  squareFeet: '#address-square-feet',
  yearBuilt: '#address-year-built',
  foundation: '#property-foundation-dropdown',
  /** Next on Steps 1–3; Schedule on Step 4; Saving while the submit is running. */
  nextButton: '#schedule-next-btn',
  scheduleButton: '#schedule-schedule-btn',
  savingButton: '#schedule-saving-btn',
  /** UNVERIFIED: the error toast's container. */
  toast: '.toast, .v-snack__content, [role=alert]',
  calendar: '[data-testid=scheduler-calendar], #schedule-calendar',
  calendarNext: '.fc-next-button',
  day: (isoDate: string) => `td[data-date="${isoDate}"]`,
  slot: 'a.fc-daygrid-event',
  step3: '#scheduler-contact-info',
  clientFirst: '#client-first-name__1',
  clientLast: '#client-last-name__1',
  clientEmail: '#client-email__1',
  clientPhone: '#client-phone__1',
  clientSmsTransactional: '#client-sms-opt-in__1',
  clientSmsMarketing: '#client-sms-marketing-opt-in__1',
  /** UNVERIFIED: the "Not here? Click to add a new Agent" link. */
  agentAddNew: 'text=/Click to add a new Agent/i',
  agentFirst: '#agent-first-name__1',
  agentLast: '#agent-last-name__1',
  agentEmail: '#agent-email__1',
  agentPhone: '#agent-phone__1',
  agentAgency: '#agent-agency-name__1',
  agentSmsTransactional: '#agent-sms-opt-in__1',
  agentSmsMarketing: '#agent-sms-marketing-opt-in__1',
  consentPrompt: '[data-testid=consent-prompt]',
  /** The decline path: continue without opting everyone in. */
  consentContinue: '[data-testid=consent-prompt-continue-anyway]',
  review: '#schedule-review-inspection',
  reviewHeader: '#schedule-review-inspection .flex',
  reviewLine: '#schedule-review-inspection .line-item',
  reviewTotalCell: '#schedule-review-inspection .total-cell',
  /** UNVERIFIED: the notes field ("Anything else you'd like us to know?"). */
  reviewNotes: '#schedule-review-inspection textarea',
} as const;

/** Non-GET requests the scheduler page makes. Anything else is blocked. */
export const ENDPOINT = {
  /** Creates the inspection. The ONLY request that books anything. */
  createInspection: /^\/inspections(\.json)?$/,
  /** Sent when leaving Step 3: texts Truss a "Schedule In Progress" alert. */
  scheduleInProgress: /^\/schedule_in_progress$/,
  /** Price calculation per service and add-on. */
  calculateCharge: /^\/api\/v1\/public\/(services|service_add_ons)\/\d+\/calculate_charge$/,
} as const;

export const TEXT = {
  slotTaken: /no longer available/i,
  somethingWrong: /something went wrong/i,
  success: /received your .* request/i,
  noTimes: /no times available/i,
} as const;
