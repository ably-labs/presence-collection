import * as Amqp from 'amqplib';
import * as Ably from 'ably';

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
const queueEndpoint = "us-east-1-a-queue.ably.io:5671/shared";

// Ably details
const apiKey = process.env.ABLY_API_KEY;
if (!apiKey) {
  throw new Error('no Ably API key set');
}
const rest = new Ably.Rest.Promise({ key: apiKey });
const realtime = new Ably.Realtime.Promise({ key: apiKey });
let channelNamespace: RegExp;
if (process.env.NAMESPACE_REGEX === undefined) {
  channelNamespace = /^presence:.*/;
} else {
  channelNamespace = new RegExp(process.env.NAMESPACE_REGEX);
}

getInitialPresenceState();

async function getInitialPresenceState() {
  try {
    // Make a request for all currently active channels
    let response = await rest.request('get', '/channels', { by: 'id' });
    let channelsToCheck = "";
    let firstElementAdded = false;
    for (let channelId of response.items) {
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
    let conn = await Amqp.connect(url);
    conn.on('error', (err) => { console.error('worker:', 'Connection error!', err); });
    // Create a communication channel
    let queueChannel = await conn.createChannel();
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

      let currentChannel = decodedEnvelope.channel;

      let messages = Ably.Realtime.PresenceMessage.fromEncodedArray(decodedEnvelope.presence);

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
      const timestamp = item.properties.timestamp;
      let occupancyUpdate: OccupancyUpdate = Object.assign(<OccupancyUpdate>{}, decodedEnvelope);
      for (let occupancy of occupancyUpdate.occupancy) {
        if (!storage.has(occupancyUpdate.channel)) {
          continue;
        }
        let channel = storage.get(occupancyUpdate.channel)!;
        channel.expectedPresenceMembers = occupancy.metrics.presenceMembers;
        console.log('occupancy: ' + JSON.stringify(decodedEnvelope) + ' timestamp=' + timestamp);
        //console.log('occupancy update: ' + occupancyUpdate.channel + '=' + occupancy.metrics.presenceMembers);
      }
    });
  } catch (err) {
    console.error('worker:', 'Queue error!', err);
  }
};

async function fetchPresenceSets(channels: string, updateMemberCount: boolean) {
  let content = { "channels": channels }
  // Make a batch request to all relevant channels for their presence sets
  let presenceSet = await rest.request('GET', '/presence', content);
  updateCurrentState(presenceSet!.items, updateMemberCount);
}

function updateCurrentState(presenceSet: string[], updateMemberCount: boolean): void {
  for (let channelPresenceSet of presenceSet) {
    let presenceSet = Object.assign(<PresenceSet>{}, channelPresenceSet);
    let channelName = presenceSet.channel;

    for (let presenceMessage of presenceSet.presence) {
      presenceUpdate(channelName, presenceMessage, updateMemberCount);
    }
  }
}

function checkPresenceMemberCount(): void {
  storage.forEach((channel: Channel, channelId: string) => {
    if (channel.expectedPresenceMembers != channel.members.size) {
      console.log('member count error detected for channel ' + channelId + ', occupancy: ' + channel.expectedPresenceMembers +
        ', us: ' + channel.members.size + '; syncing');
      fetchPresenceSets(channelId, true);
    }
  });
}
setInterval(checkPresenceMemberCount, 5000);

class MemberKey {
  clientId: string;
  connectionId: string;
  constructor(clientId: string, connectionId: string) {
    this.clientId = clientId;
    this.connectionId = connectionId;
  }
  toString(): string {
    return this.clientId + '-' + this.connectionId;
  }
}

class Member {
  latestTimestamp: number;
  constructor(latestTimestamp: number) {
    this.latestTimestamp = latestTimestamp;
  }
}

class Channel {
  expectedPresenceMembers: number;
  members: Map<string, Member>;
  constructor() {
    this.expectedPresenceMembers = 0;
    this.members = new Map<string, Member>();
  }
}

let storage = new Map<string, Channel>();

function displayStorage() {
  console.log('storage:');
  storage.forEach((channel: Channel, channelId: string) => {
    console.log('\t' + channelId + ': (' + channel.expectedPresenceMembers + ')');
    channel.members.forEach((member: Member, memberKey: string) => {
      console.log('\t\t' + memberKey + ': ' + member.latestTimestamp);
    })
  });
}

function presenceUpdate(channelId: string, update: Ably.Types.PresenceMessage, updateMemberCount: boolean) {
  // TODO: what if clientId contains '-'?
  switch (update.action.toString()) {
    case "1": // BUG: presence queue returns an integer as the action
    case "present":
    case "2": // BUG: presence queue returns an integer as the action
    case "enter": {
      if (!storage.has(channelId)) {
        storage.set(channelId, new Channel());
      }
      let channel = storage.get(channelId)!;
      let memberKey = new MemberKey(update.clientId, update.connectionId);
      if (!channel.members.has(memberKey.toString())) {
        channel.members.set(memberKey.toString(), new Member(update.timestamp));
      } else {
        let member = channel.members.get(memberKey.toString())!;
        member.latestTimestamp = update.timestamp;
      }
      if (updateMemberCount) {
        channel.expectedPresenceMembers = channel.members.size;
      }
      displayStorage();
      break;
    }
    case "3": // BUG: presence queue returns an integer as the action
    case "leave": {
      if (!storage.has(channelId)) {
        break;
      }
      let channel = storage.get(channelId)!;
      let memberKey = new MemberKey(update.clientId, update.connectionId);
      if (!channel.members.has(memberKey.toString())) {
        break;
      }
      let member = channel.members.get(memberKey.toString())!;
      // Ignore a leave event if its timestamp is older than ours
      if (update.timestamp > member.latestTimestamp) {
        channel.members.delete(memberKey.toString());
      }
      if (updateMemberCount) {
        channel.expectedPresenceMembers = channel.members.size;
      }
      if (channel.members.size == 0) {
        storage.delete(channelId);
      }
      displayStorage();
      break;
    }
  }
}
