import { waitlistMessage, type Waitlists } from './waitlists';
import type { Notifications } from './notifications';
/** Source-only worker. No handler is wired into accepted Lambda artifacts.
 * A deployment must explicitly approve provider and reminder/consent rollout.
 */
export function createNotificationWorker(
  service: Notifications,
  waitlists?: Pick<Waitlists, 'deliver'>,
) {
  return async (event: {
    Records?: { messageId: string; body: string }[];
    poll?: boolean;
  }) => {
    if (event.poll === true) {
      await service.poll();
      return { batchItemFailures: [] };
    }
    if (!Array.isArray(event.Records) || event.Records.length > 10)
      throw Error('Invalid notification batch');
    const batchItemFailures: { itemIdentifier: string }[] = [];
    for (const record of event.Records) {
      try {
        if (record.body.length > 8192) throw Error('Message too large');
        const data = JSON.parse(record.body);
        if (data?.type === 'WAITLIST') {
          if (!waitlists) throw Error('Waitlists disabled');
          await waitlists.deliver(waitlistMessage.parse(data));
        } else await service.handle(data);
      } catch {
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures };
  };
}
