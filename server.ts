import * as Amqp from 'amqplib';
import * as Ably from 'ably';
const Mmh3 = require('murmurhash3');

// Interfaces
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

interface PresenceSet {
  channel: string,
  presence: Ably.Types.PresenceMessage[],
}

// AMQP
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

// Ably details
const apiKey = process.env.ABLY_API_KEY;
if (!apiKey) {
  throw new Error('no Ably API key set');
}
const environment = process.env.ABLY_ENVIRONMENT;
const rest = new Ably.Rest.Promise({ key: apiKey, environment: environment });
const realtime = new Ably.Realtime.Promise({ key: apiKey, environment: environment });
let channelNamespace: RegExp;
if (process.env.NAMESPACE_REGEX === undefined) {
  channelNamespace = /^presence:.*/;
} else {
  channelNamespace = new RegExp(process.env.NAMESPACE_REGEX);
}

if (process.env.FETCH_INITIAL_PRESENCE_STATE != undefined && process.env.FETCH_INITIAL_PRESENCE_STATE == "true") {
  getInitialPresenceState();
} else {
  consumeFromAbly();
}

async function getInitialPresenceState() {
  try {
    // Make a request for all currently active channels
    const response = await rest.request('get', '/channels', { by: 'id' });
    let channelsToCheck = "";
    let firstElementAdded = false;
    for (const channelId of response.items) {
      if (!channelId.match(channelNamespace)) {
        continue;
      }
      if (!firstElementAdded) {
        firstElementAdded = true;
        channelsToCheck = channelId;
      } else {
        channelsToCheck += "," + channelId;
      }
    }
    await fetchPresenceSets(channelsToCheck, true);

    consumeFromAbly();
  }
  catch (err: any) {
    console.log('An error occurred; err = ' + err.toString());
  }
}

async function consumeFromAbly() {
  const endpoint = queueEndpoint;
  const url = 'amqps://' + apiKey + '@' + endpoint;

  try {
    // Connect to Ably queue
    const conn = await Amqp.connect(url);
    conn.on('error', (err) => { console.error('worker:', 'Connection error!', err); });
    // Create a communication channel
    const queueChannel = await conn.createChannel();
    // Consume from queue
    const appId = apiKey?.split('.')[0];
    const presenceQueue = appId + ":" + presenceQueueName;
    const occupancyQueue = appId + ":" + occupancyQueueName;

    queueChannel.consume(presenceQueue, (item) => {
      if (!item) {
        console.warn('queueChannel.consume returned a null item');
        return;
      }
      // Remove message from queue
      queueChannel.ack(item);

      const decodedEnvelope = JSON.parse(item.content.toString());

      const currentChannel = decodedEnvelope.channel;

      const messages = Ably.Realtime.PresenceMessage.fromEncodedArray(decodedEnvelope.presence);

      messages.forEach((message) => {
        presenceUpdate(currentChannel, message, false);
      });
    });

    queueChannel.consume(occupancyQueue, async (item) => {
      if (!item) {
        console.warn('queueChannel.consume returned a null item');
        return;
      }
      // Remove message from queue
      queueChannel.ack(item);

      const decodedEnvelope = JSON.parse(item.content.toString());
      const update: OccupancyUpdate = Object.assign(<OccupancyUpdate>{}, decodedEnvelope);
      for (const occupancy of update.occupancy) {
        occupancyUpdate(update.channel, occupancy);
      }
    });
  } catch (err) {
    console.error('worker:', 'Queue error!', err);
  }
};

async function fetchPresenceSets(channels: string, updateMemberCount: boolean) {
  const content = { "channels": channels }
  // Make a batch request to all relevant channels for their presence sets
  const presenceSet = await rest.request('GET', '/presence', content);
  updateCurrentState(presenceSet!.items, updateMemberCount);
}

function updateCurrentState(presenceSet: string[], updateMemberCount: boolean): void {
  for (const channelPresenceSet of presenceSet) {
    const presenceSet = Object.assign(<PresenceSet>{}, channelPresenceSet);
    const channelName = presenceSet.channel;

    for (const presenceMessage of presenceSet.presence) {
      presenceUpdate(channelName, presenceMessage, updateMemberCount);
    }
  }
}

function checkPresenceMemberCount(channelId: string): void {
  if (!storage.has(channelId)) {
    return;
  }
  const channel = storage.get(channelId)!;
  channel.memberCountCheckTimeout = null;
  if (channel.expectedPresenceMembers != channel.members.size) {
    console.log('member count error detected for channel ' + channelId + ', occupancy: ' + channel.expectedPresenceMembers +
      ', us: ' + channel.members.size + '; syncing');
    fetchPresenceSets(channelId, true);
  }
}

class MemberKey {
  hash: number;
  constructor(clientId: string, connectionId: string) {
    this.hash = Mmh3.murmur32Sync(clientId + connectionId);
  }
}

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

const storage = new Map<string, Channel>();

function emplace<K, V>(map: Map<K, V>, key: K, defaultValue: () => V): V {
  if (!map.has(key)) {
    const value = defaultValue();
    map.set(key, value);
    return value;
  }
  return map.get(key)!;
}

function displayStorage() {
  console.log('new storage state:');
  storage.forEach((channel: Channel, channelId: string) => {
    console.log('\t' + channelId + ': (' + channel.expectedPresenceMembers + ')');
    channel.members.forEach((member: Member, _) => {
      console.log('\t\t' + member.clientId + '-' + member.connectionId + ': ' + member.latestTimestamp);
    })
  });
}

function setupMemberCountCheckTimeout(channel: Channel, channelId: string) {
  if (channel.memberCountCheckTimeout) {
    clearTimeout(channel.memberCountCheckTimeout);
  }
  channel.memberCountCheckTimeout = setTimeout(() => checkPresenceMemberCount(channelId), 5000);
}

function occupancyUpdate(channelId: string, occupancy: Occupancy) {
  if (!storage.has(channelId)) {
    return;
  }
  const channel = storage.get(channelId)!;
  channel.expectedPresenceMembers = occupancy.metrics.presenceMembers;
  setupMemberCountCheckTimeout(channel, channelId);
  console.log('> occupancy update: ' + channelId + '=' + occupancy.metrics.presenceMembers);
  displayStorage();
}

function presenceUpdate(channelId: string, update: Ably.Types.PresenceMessage, updateMemberCount: boolean) {
  console.log('> presence update: ' + channelId);
  // Ignore updates with a timestamp older than ours
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
  switch (update.action.toString()) { // BUG: presence queue returns an integer as the action
    case "1":
    case "present":
    case "2":
    case "enter":
    case "4":
    case "update": {
      const channel = emplace(storage, channelId, () => new Channel());
      const member = emplace(channel.members, memberKey.hash, () => new Member(update.clientId, update.connectionId));
      member.latestTimestamp = update.timestamp;
      setupMemberCountCheckTimeout(channel, channelId);
      if (updateMemberCount) {
        channel.expectedPresenceMembers = channel.members.size;
      }
      displayStorage();
      break;
    }
    case "3":
    case "leave": {
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
        setupMemberCountCheckTimeout(channel, channelId);
      }
      displayStorage();
      break;
    }
  }
}
