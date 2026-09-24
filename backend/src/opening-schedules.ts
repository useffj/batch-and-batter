import {
  CreateScheduleCommand,
  GetScheduleCommand,
  type SchedulerClient,
  type CreateScheduleCommandInput,
} from '@aws-sdk/client-scheduler';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { idSchema, type Drop } from './domain';

export const schedulerSource = 'batch-and-batter.scheduler';
export interface OpeningSchedules {
  ensure(drop: Drop): Promise<void>;
}
export class OpeningScheduleError extends Error {
  constructor(
    public readonly code: 'OPENING_TIME_PASSED' | 'OPENING_SCHEDULE_CONFLICT',
  ) {
    super(code);
  }
}
export class SchedulerOpeningSchedules implements OpeningSchedules {
  constructor(
    private readonly client: Pick<SchedulerClient, 'send'>,
    private readonly group: string,
    private readonly targetArn: string,
    private readonly roleArn: string,
  ) {
    if (!group || !targetArn || !roleArn)
      throw new Error('Opening schedule configuration required');
  }
  async ensure(drop: Drop): Promise<void> {
    idSchema.parse(drop.dropId);
    // Scheduler accepts whole seconds: round UP, never earlier than stored opensAt.
    const time = Math.ceil(Date.parse(drop.opensAt) / 1000) * 1000;
    if (!Number.isFinite(time) || drop.status !== 'SCHEDULED')
      throw new OpeningScheduleError('OPENING_SCHEDULE_CONFLICT');
    if (Date.now() >= Date.parse(drop.opensAt))
      throw new OpeningScheduleError('OPENING_TIME_PASSED');
    const expected = {
      Name: `open-${drop.dropId}`,
      GroupName: this.group,
      ScheduleExpression: `at(${new Date(time).toISOString().slice(0, 19)})`,
      ScheduleExpressionTimezone: 'UTC',
      FlexibleTimeWindow: { Mode: 'OFF' as const },
      State: 'ENABLED' as const,
      ActionAfterCompletion: 'DELETE' as const,
      Target: {
        Arn: this.targetArn,
        RoleArn: this.roleArn,
        Input: JSON.stringify({
          source: schedulerSource,
          operation: 'openDrop',
          dropId: drop.dropId,
        }),
        RetryPolicy: { MaximumEventAgeInSeconds: 900, MaximumRetryAttempts: 3 },
      },
    } satisfies CreateScheduleCommandInput;
    try {
      await this.client.send(
        new CreateScheduleCommand({
          ...expected,
          ClientToken: createHash('sha256')
            .update(JSON.stringify(expected))
            .digest('hex'),
        }),
      );
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'ConflictException')
        throw error;
    }
    const existing = await this.client.send(
      new GetScheduleCommand({
        Name: expected.Name,
        GroupName: expected.GroupName,
      }),
    );
    // A matching name is insufficient: refuse altered targets, role, payload or policy.
    for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
      if (!isDeepStrictEqual(existing[key], expected[key]))
        throw new OpeningScheduleError('OPENING_SCHEDULE_CONFLICT');
    }
    if (existing.StartDate || existing.EndDate || existing.KmsKeyArn)
      throw new OpeningScheduleError('OPENING_SCHEDULE_CONFLICT');
  }
}
