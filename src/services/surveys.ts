import type { NexusIdentity } from '../identity';
import type { NexusHttp } from '../http';

export interface NexusSurvey {
  id: string;
  name: string;
  type: string;
  questions: unknown[];
  [key: string]: unknown;
}

export interface ActiveOptions {
  properties?: Record<string, unknown>;
  deviceType?: string;
}

/** In-product surveys — fetch eligible surveys and submit answers. Headless
 * (bring your own UI); works in any framework and server-side. */
export class NexusSurveys {
  private activeList: NexusSurvey[] = [];

  constructor(
    private readonly http: NexusHttp,
    private readonly id: NexusIdentity,
  ) {}

  /** Surveys the current user is eligible for (targeting/sampling/capping applied). */
  async fetch(options: ActiveOptions = {}): Promise<NexusSurvey[]> {
    const res = await this.http.post('/partner/surveys/active', {
      ...(this.id.distinctId ? { distinctId: this.id.distinctId } : {}),
      deviceKey: this.id.deviceKey,
      properties: { ...this.id.traits, ...options.properties },
      ...(options.deviceType ? { deviceType: options.deviceType } : {}),
      ...this.id.wireContext,
    });
    const data = (res?.['data'] ?? res) as Record<string, unknown> | undefined;
    this.activeList = (data?.['surveys'] as NexusSurvey[] | undefined) ?? [];
    return this.activeList;
  }

  get active(): NexusSurvey[] {
    return [...this.activeList];
  }

  byId(id: string): NexusSurvey | undefined {
    return this.activeList.find((s) => s.id === id);
  }

  /** Submit a response (partial, complete, or dismissed). Answers keyed by question id. */
  async respond(
    surveyId: string,
    answers: Record<string, unknown>,
    options: { responseId?: string; completed?: boolean; dismissed?: boolean; iterationKey?: string } = {},
  ): Promise<void> {
    await this.http.post('/partner/surveys/responses', {
      surveyId,
      answers: Object.keys(answers).length === 0 ? {} : answers,
      ...(options.responseId ? { responseId: options.responseId } : {}),
      ...(options.completed ? { completed: true } : {}),
      ...(options.dismissed ? { dismissed: true } : {}),
      ...(options.iterationKey ? { iterationKey: options.iterationKey } : {}),
      ...(this.id.distinctId ? { distinctId: this.id.distinctId } : {}),
      sessionKey: this.id.sessionKey,
      deviceKey: this.id.deviceKey,
      ...this.id.wireContext,
    });
  }

  complete(surveyId: string, answers: Record<string, unknown>, options = {}): Promise<void> {
    return this.respond(surveyId, answers, { ...options, completed: true });
  }
  dismiss(surveyId: string, options = {}): Promise<void> {
    return this.respond(surveyId, {}, { ...options, dismissed: true });
  }
}
