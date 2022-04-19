/*
 This code sample shows how a global presence set can be set up and updated.
 It uses Ably queue rules to fetch presence and occupancy updates on multiple channels and aggregates them.
 Occupancy updates are used to verify that the presence member count is as expected.
 If the member count is not correct then a presence set REST request is done to resynchronise the presence set.
 Timestamps are checked to prevent an earlier event being processed after a newer one.
 Environment variables:
 ABLY_API_KEY: Ably API key
 ABLY_ENVIRONMENT: environment to use (leave empty unless your are using a dedicated environment)
 NAMESPACE_REGEX: namespace used to filter channels to fetch presence data on
 PRESENCE_QUEUE_NAME: presence queue name
 OCCUPANCY_QUEUE_NAME: occupancy queue name
 QUEUE_ENDPOINT: queues endpoint
 FETCH_INITIAL_PRESENCE_STATE: should an initial presence state be fetched? (note: if this is not enabled
  presence members will be added to the in-memory storage only when a presence event has been received)
*/
import * as Amqp from 'amqplib';
import * as Ably from 'ably';
const Mmh3 = require('murmurhash3');

// Metrics returned either a REST request or via queues.
// We are only using interested in presenceMembers.
interface Metrics {
  connections: number;
  publishers: number;
  subscribers: number;
  presenceConnections: number;
  presenceMembers: number;
  presenceSubscribers: number;
}

interface Occupancy {
  metrics: Metrics;
}

interface OccupancyUpdate {
  channel: string;
  occupancy: Occupancy[];
}

// Presence set as returned by the REST API.
interface PresenceSet {
  channel: string,
  presence: Ably.Types.PresenceMessage[],
}

// AMQP (queues) parameters.
let presenceQueueName: string;
if (process.env.PRESENCE_QUEUE_NAME == undefined) {
  presenceQueueName = 'presence-queue';
} else {
  presenceQueueName = process.env.PRESENCE_QUEUE_NAME;
}
let occupancyQueueName: string;
if (process.env.OCCUPANCY_QUEUE_NAME == undefined) {
  occupancyQueueName = 'occupancy-queue';
} else {
  occupancyQueueName = process.env.OCCUPANCY_QUEUE_NAME;
}
let queueEndpoint: string;
if (process.env.QUEUE_ENDPOINT == undefined) {
  queueEndpoint = 'eu-west-1-a-queue.ably.io:5671/shared';
} else {
  queueEndpoint = process.env.QUEUE_ENDPOINT;
}

// Ably parameters.
const apiKey = process.env.ABLY_API_KEY;
if (!apiKey) {
  throw new Error('No Ably API key set');
}
const environment = process.env.ABLY_ENVIRONMENT;
const rest = new Ably.Rest.Promise({ key: apiKey, environment: environment });
let channelNamespace: RegExp;
if (process.env.NAMESPACE_REGEX === undefined) {
  channelNamespace = /^presence:.*/;
} else {
  channelNamespace = new RegExp(process.env.NAMESPACE_REGEX);
}

if (process.env.FETCH_INITIAL_PRESENCE_STATE === "true") {
  getInitialPresenceState();
} else {
  consumeFromAbly();
}

// Fetches initial presence sets from all matching active channels.
// This uses channel enumeration (see https://ably.com/documentation/rest/channel-status#enumeration-rest
// for the limits).
async function getInitialPresenceState() {
  try {
    const response = await rest.request('get', '/channels', { by: 'id' });
    const channels = response.items.filter(item => item.match(channelNamespace)).join(",");
    await fetchPresenceSets(channels, true);

    consumeFromAbly();
  }
  catch (err: any) {
    console.log('An error occurred; err = ' + err.toString());
  }
}

// Consumes messages from the Ably queues.
async function consumeFromAbly() {
  const endpoint = queueEndpoint;
  const url = 'amqps://' + apiKey + '@' + endpoint;

  try {
    // Connect to Ably queue.
    const conn = await Amqp.connect(url);
    conn.on('error', (err) => { console.error('worker:', 'Connection error!', err); });
    // Create a communication channel.
    const queueChannel = await conn.createChannel();
    // Consume from the queues.
    const appId = apiKey?.split('.')[0];
    const presenceQueue = appId + ":" + presenceQueueName;
    const occupancyQueue = appId + ":" + occupancyQueueName;

    queueChannel.consume(presenceQueue, (item) => {
      if (!item) {
        console.warn('queueChannel.consume returned a null item');
        return;
      }

      const decodedEnvelope = JSON.parse(item.content.toString());
      const currentChannel = decodedEnvelope.channel;
      const messages = Ably.Realtime.PresenceMessage.fromEncodedArray(decodedEnvelope.presence);
      messages.forEach((message) => {
        presenceUpdate(currentChannel, message, false);
      });

      // Remove message from queue.
      // We do it here so that any thrown exception will re-trigger processing this message.
      queueChannel.ack(item);
    });

    queueChannel.consume(occupancyQueue, async (item) => {
      if (!item) {
        console.warn('queueChannel.consume returned a null item');
        return;
      }

      const decodedEnvelope = JSON.parse(item.content.toString());
      const update: OccupancyUpdate = Object.assign(<OccupancyUpdate>{}, decodedEnvelope);
      for (const occupancy of update.occupancy) {
        occupancyUpdate(update.channel, occupancy);
      }

      // Remove message from queue.
      // We do it here so that any thrown exception will re-trigger processing this message.
      queueChannel.ack(item);
    });
  } catch (err) {
    console.error('worker:', 'Queue error!', err);
  }
};

// Fetch presence set from a list of channels.
async function fetchPresenceSets(channels: string, updateMemberCount: boolean) {
  const content = { "channels": channels }
  const result = await rest.request('GET', '/presence', content);
  for (const item of result.items) {
    const presenceSet: PresenceSet = Object.assign(<PresenceSet>{}, item);
    const messages = Ably.Realtime.PresenceMessage.fromEncodedArray(presenceSet.presence);
    for (const message of messages) {
      presenceUpdate(presenceSet.channel, message, updateMemberCount);
    }
  }
}

// Called when the presence member count (set using occupancy messages)
// needs to be checked with the presence member map (filled using presence events).
// Triggers fetching the current presence set if both are not equal.
function checkPresenceMemberCount(channelId: string): void {
  if (!storage.has(channelId)) {
    return;
  }
  const channel = storage.get(channelId)!;
  channel.memberCountCheckTimeout = null;
  if (channel.expectedPresenceMembers != channel.members.size) {
    console.log('Member count error detected for channel ' + channelId + ', occupancy: ' + channel.expectedPresenceMembers +
      ', us: ' + channel.members.size + '; syncing');
    fetchPresenceSets(channelId, true);
  }
}

// A presence member key. Presence members can be uniquely identified using
// a connection id and a client id, so this computes a hash of both.
// This is used as a key in the storage map.
class MemberKey {
  hash: number;
  constructor(clientId: string, connectionId: string) {
    this.hash = Mmh3.murmur32Sync(clientId + connectionId);
  }
}

// A presence member. The timestamp is used to ensure we don't override presence data
// because we have received an earlier event.
class Member {
  latestTimestamp: number;
  clientId: string;
  connectionId: string;
  constructor(clientId: string, connectionId: string) {
    this.clientId = clientId;
    this.connectionId = connectionId;
    this.latestTimestamp = 0;
  }
}

// Channel data.
class Channel {
  expectedPresenceMembers: number;
  memberCountCheckTimeout: NodeJS.Timeout | null;
  members: Map<number, Member>;
  constructor() {
    this.expectedPresenceMembers = 0;
    this.memberCountCheckTimeout = null;
    this.members = new Map<number, Member>();
  }
}

// Global storage map.
const storage = new Map<string, Channel>();

// 'emplace' operation on a map.
function emplace<K, V>(map: Map<K, V>, key: K, defaultValue: () => V): V {
  if (!map.has(key)) {
    const value = defaultValue();
    map.set(key, value);
    return value;
  }
  return map.get(key)!;
}

// Displays storage contents.
function displayStorage() {
  console.log('new storage state:');
  storage.forEach((channel: Channel, channelId: string) => {
    console.log('\t' + channelId + ': (' + channel.expectedPresenceMembers + ')');
    channel.members.forEach((member: Member, _) => {
      console.log('\t\t' + member.clientId + '-' + member.connectionId + ': ' + member.latestTimestamp);
    })
  });
}

// Sets a timer to check presence count for a channel. Resets any active counter.
function setupMemberCountCheckTimeout(channel: Channel, channelId: string) {
  if (channel.memberCountCheckTimeout) {
    clearTimeout(channel.memberCountCheckTimeout);
  }
  channel.memberCountCheckTimeout = setTimeout(() => checkPresenceMemberCount(channelId), 5000);
}

// Process an occupancy update.
function occupancyUpdate(channelId: string, occupancy: Occupancy) {
  if (!storage.has(channelId)) {
    return;
  }
  const channel = storage.get(channelId)!;
  channel.expectedPresenceMembers = occupancy.metrics.presenceMembers;
  setupMemberCountCheckTimeout(channel, channelId); // Check presence member count in a few seconds.
  console.log('> occupancy update: ' + channelId + '=' + occupancy.metrics.presenceMembers);
  displayStorage();
}

// Process a presence update.
// updateMemberCount is set to true when we process a presence set returned by the REST request.
// In that case we are not expecting an occupancy update, so we can directly update the member count.
function presenceUpdate(channelId: string, update: Ably.Types.PresenceMessage, updateMemberCount: boolean) {
  console.log('> presence update: ' + channelId);
  // Ignore updates with a timestamp older than ours.
  const memberKey = new MemberKey(update.clientId, update.connectionId);
  if (storage.has(channelId)) {
    const channel = storage.get(channelId)!;
    if (channel.members.has(memberKey.hash)) {
      const member = channel.members.get(memberKey.hash)!;
      if (update.timestamp < member.latestTimestamp) {
        return;
      }
    }
  }
  switch (update.action) {
    case "present":
    case "enter":
    case "update": {
      const channel = emplace(storage, channelId, () => new Channel());
      const member = emplace(channel.members, memberKey.hash, () => new Member(update.clientId, update.connectionId));
      member.latestTimestamp = update.timestamp;
      setupMemberCountCheckTimeout(channel, channelId); // Check presence member count in a few seconds.
      if (updateMemberCount) {
        channel.expectedPresenceMembers = channel.members.size;
      }
      displayStorage();
      break;
    }
    case "leave": {
      // Do some cleanup if needed (remove empty channels).
      if (!storage.has(channelId)) {
        break;
      }
      const channel = storage.get(channelId)!;
      if (!channel.members.has(memberKey.hash)) {
        break;
      }
      channel.members.delete(memberKey.hash);
      if (updateMemberCount) {
        channel.expectedPresenceMembers = channel.members.size;
      }
      if (channel.members.size == 0) {
        storage.delete(channelId);
      } else {
        setupMemberCountCheckTimeout(channel, channelId); // Check presence member count in a few seconds.
      }
      displayStorage();
      break;
    }
  }
}
