/** Configuration for the Slack source connector. */
export interface SlackConnectorConfig
{
  /** Slack Bot OAuth token (xoxb-...). */
  botToken: string;

  /** List of Slack channel IDs to harvest. */
  channelIds: string[];

  /** Maximum messages to fetch per channel per sync cycle. */
  maxMessagesPerCycle: number;

  /** How long to wait between full sync cycles (milliseconds). */
  syncIntervalMs: number;
}
