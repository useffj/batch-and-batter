export type CancellationView = {
  hours: number;
  deadline: string | null;
  eligible: boolean;
  exceptionEligible: boolean;
  unavailable: string | null;
  request: null | {
    requestId: string;
    type: 'GUARANTEED' | 'EXCEPTION';
    status: string;
    reason: string;
    createdAt: string;
    updatedAt: string;
    revision: number;
    eligibility: {
      deadline: string;
      amountCents: number;
      currency: string;
      pickupDate: string;
      pickupStart: string;
    };
  };
};
export const requestLabels: Record<string, string> = {
  RECEIVED_PENDING_PROCESSING:
    'Cancellation request received — execution status is separate',
  EXCEPTION_REQUESTED: 'Exception request received — awaiting review',
  APPROVED_PENDING_PROCESSING:
    'Exception approved — refund execution is separate',
  DECLINED: 'Exception request declined',
};
export const requestTime = (s: string) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver',
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(new Date(s)) + ' Mountain Time';
