export type Message = {
  to: string;
  subject: string;
  text: string;
  operationId: string;
};
export interface MessageProvider {
  send(message: Message): Promise<void>;
}
// Only a confirmed pre-acceptance rejection is safe to retry automatically.
export class DeliveryFailure extends Error {
  constructor(readonly retryable = false) {
    super('PROVIDER_REJECTED');
  }
}
export class MockEmailProvider implements MessageProvider {
  readonly messages: Message[] = [];
  async send(message: Message) {
    this.messages.push(structuredClone(message));
  }
}
export class MockSmsProvider extends MockEmailProvider {}

import { SendEmailCommand, type SESv2Client } from '@aws-sdk/client-sesv2';
/** Inject a client configured with maxAttempts: 1. Unknown outcomes are never retried. */
export class SesEmailProvider implements MessageProvider {
  constructor(
    private client: Pick<SESv2Client, 'send'>,
    private from: string,
  ) {
    if (!from || /[\r\n]/.test(from)) throw Error('SES sender required');
  }
  async send(message: Message) {
    try {
      const response = await this.client.send(
        new SendEmailCommand({
          FromEmailAddress: this.from,
          Destination: { ToAddresses: [message.to] },
          Content: {
            Simple: {
              Subject: { Data: message.subject, Charset: 'UTF-8' },
              Body: { Text: { Data: message.text, Charset: 'UTF-8' } },
            },
          },
          EmailTags: [{ Name: 'operation', Value: message.operationId }],
        }),
      );
      if (!response.MessageId) throw Error('Unknown SES acknowledgement');
    } catch (e) {
      const name = e instanceof Error ? e.name : '';
      if (['TooManyRequestsException', 'LimitExceededException'].includes(name))
        throw new DeliveryFailure(true);
      if (
        [
          'MessageRejected',
          'BadRequestException',
          'MailFromDomainNotVerifiedException',
          'AccountSuspendedException',
          'SendingPausedException',
        ].includes(name)
      )
        throw new DeliveryFailure(false);
      throw Error('Unknown delivery outcome');
    }
  }
}
