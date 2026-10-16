import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import {
  CreateScheduleCommand,
  GetScheduleCommand,
  type SchedulerClient,
} from '@aws-sdk/client-scheduler';
import {
  notificationMessage,
  type NotificationMessage,
  type NotificationTransport,
} from './notifications';
import { reminderSchedule } from './notification-contract';
export class AwsNotificationTransport implements NotificationTransport {
  constructor(
    private sqs: Pick<SQSClient, 'send'>,
    private scheduler: Pick<SchedulerClient, 'send'>,
    private config: {
      queueUrl: string;
      queueArn: string;
      scheduleRoleArn: string;
      groupName: string;
    },
  ) {
    if (Object.values(config).some((v) => !v))
      throw Error('Notification transport configuration required');
  }
  async enqueue(message: NotificationMessage) {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.config.queueUrl,
        MessageBody: JSON.stringify(notificationMessage.parse(message)),
      }),
    );
  }
  async schedule(s: ReturnType<typeof reminderSchedule>) {
    const Target = {
      Arn: this.config.queueArn,
      RoleArn: this.config.scheduleRoleArn,
      Input: JSON.stringify({ type: 'REMINDER', date: s.date }),
    };
    const expected = {
      Name: s.name,
      GroupName: this.config.groupName,
      ScheduleExpression: s.expression,
      ScheduleExpressionTimezone: s.timezone,
      FlexibleTimeWindow: { Mode: 'OFF' as const },
      Target,
      State: 'ENABLED' as const,
    };
    try {
      await this.scheduler.send(new CreateScheduleCommand(expected));
    } catch (e) {
      if (!(e instanceof Error) || e.name !== 'ConflictException') throw e;
      const current = await this.scheduler.send(
        new GetScheduleCommand({
          Name: s.name,
          GroupName: this.config.groupName,
        }),
      );
      if (
        current.ScheduleExpression !== expected.ScheduleExpression ||
        current.ScheduleExpressionTimezone !==
          expected.ScheduleExpressionTimezone ||
        current.FlexibleTimeWindow?.Mode !== 'OFF' ||
        current.State !== 'ENABLED' ||
        current.Target?.Arn !== Target.Arn ||
        current.Target?.RoleArn !== Target.RoleArn ||
        current.Target?.Input !== Target.Input
      )
        throw Error('Reminder schedule conflicts with approved configuration');
    }
  }
}
export class MockNotificationTransport implements NotificationTransport {
  readonly messages: NotificationMessage[] = [];
  readonly schedules = new Map<string, ReturnType<typeof reminderSchedule>>();
  async enqueue(m: NotificationMessage) {
    this.messages.push(structuredClone(m));
  }
  async schedule(s: ReturnType<typeof reminderSchedule>) {
    const prior = this.schedules.get(s.name);
    if (prior && JSON.stringify(prior) !== JSON.stringify(s))
      throw Error('Schedule conflict');
    this.schedules.set(s.name, structuredClone(s));
  }
}
