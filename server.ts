import * as Amqp from 'amqplib/callback_api';
import * as Ably from 'ably';
import internal = require('stream');
import { Channel } from 'diagnostics_channel';

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

interface ChannelStatus {
  isActive: boolean;
  occupancy: Occupancy | null;
}

interface ChannelDetails {
  channelId: string;
  status: ChannelStatus;
}

let currentStateByChannel: object = {};
let currentStateByClientId: object = {};
let currentStateByConnectionId: object = {};
let shouldSendUpdate = false;
let amqpConnection: Amqp.Connection;

// Consume on start
let consumeOnStart = process.env.CONSUME_ON_START != undefined;

// AMQP
const apiKey = process.env.ABLY_API_KEY;
if (!apiKey) {
  throw new Error('no Ably API key set');
}
let queueName: string;
if (process.env.QUEUE_NAME == undefined) {
  queueName = 'presence-queue';
} else {
  queueName = process.env.QUEUE_NAME;
}
const queueEndpoint = "us-east-1-a-queue.ably.io:5671/shared";

// Ably details
const rest = new Ably.Rest({ key: apiKey });
const realtime = new Ably.Realtime({ key: apiKey });
let channelNamespace: RegExp;
if (process.env.NAMESPACE_REGEX === undefined) {
  channelNamespace = /^presence:.*/;
} else {
  channelNamespace = new RegExp(process.env.NAMESPACE_REGEX);
}
const channelForPublishingByChannel = rest.channels.get('presencebatch:by-channel');
const channelForPublishingByClientId = rest.channels.get('presencebatch:by-clientId');
const channelForPublishingByConnection = rest.channels.get('presencebatch:by-connectionId');

const channelOptions: Ably.Types.ChannelOptions = {
  params: {
    'rewind': '1'
  },
  cipher: undefined,
  modes: [],
};
const commandChannel = realtime.channels.get('presencebatch:commands', channelOptions);
commandChannel.subscribe('update', (message) => {
  if (message.data == 'start') {
    startPresenceUpdates();
  } else if (message.data == 'stop') {
    stopPresenceUpdates();
  }
});

if(consumeOnStart){
  startPresenceUpdates();
}

function startPresenceUpdates(): void {
  if (amqpConnection != undefined) {
    amqpConnection.close();
  }
  shouldSendUpdate = false;
  getInitialPresenceState();
}

function stopPresenceUpdates(): void {
  if (amqpConnection != undefined) {
    amqpConnection.close();
  }
  shouldSendUpdate = false;
}

function sendPresenceSetsToAbly(): void {
  if (shouldSendUpdate) {
    setTimeout(() => {
      /*
      channelForPublishingByChannel.publish('presence-update', currentStateByChannel);
      channelForPublishingByClientId.publish('presence-update', currentStateByClientId);
      channelForPublishingByConnection.publish('presence-update', currentStateByConnectionId);
      */
      sendPresenceSetsToAbly();
    }, 3000);
  }
}

function consumeFromAbly() {
  const endpoint = queueEndpoint;
  const url = 'amqps://' + apiKey + '@' + endpoint;

  // Connect to Ably queue
  Amqp.connect(url, (err, conn) => {
    if (err) {
      return console.error('worker:', 'Queue error!', err);
    }
    amqpConnection = conn;
    // Create a communication channel
    conn.createChannel((err, queueChannel) => {
      if (err) {
        return console.error('worker:', 'Queue error!', err);
      }
      consumeFromQueue(queueChannel);
    });

    conn.on('error', (err) => { console.error('worker:', 'Connection error!', err); });
  });
};

function consumeFromQueue(queueChannel: Amqp.Channel): void {
  const appId = apiKey?.split('.')[0];
  const queue = appId + ":" + queueName;

  queueChannel.consume(queue, (item) => {
    if (!item) {
      console.warn('queueChannel.consume returned a null item');
      return;
    }
    const decodedEnvelope = JSON.parse(item.content.toString());

    let currentChannel = decodedEnvelope.channel;

    let messages = Ably.Realtime.PresenceMessage.fromEncodedArray(decodedEnvelope.presence);

    messages.forEach((message) => {
      let clientId = message.clientId;
      let connectionId = message.connectionId;

      presenceUpdate(currentChannel, message);

      /*
      // Update presence by channel object
      updatePresenceObject(currentStateByChannel, currentChannel, clientId, connectionId, message);
      // Update presence by clientID object
      updatePresenceObject(currentStateByClientId, clientId, currentChannel, connectionId, message);
      // Update presence by connectionId object
      updatePresenceObject(currentStateByConnectionId, connectionId, clientId, currentChannel, message);
      */
    });

    // Remove message from queue
    queueChannel.ack(item);
  });
}

function getInitialPresenceState(): void {
  // Make a request for all currently active channels
  rest.request(
    'get',
    '/channels',
    {direction: 'forwards'},
    null,
    null,
    (err, response) => {
      if(err) {
        console.log('An error occurred; err = ' + err.toString());
      } else {
        getPresenceSets(response);
      }
    }
  );
}

function subscribeToOccupancyEvents(channelId:string) {
  const channelOptions: Ably.Types.ChannelOptions = {
    params: {
      'occupancy': 'metrics'
    },
    cipher: undefined,
    modes: [],
  };
  const channel = realtime.channels.get(channelId, channelOptions);
  channel.subscribe('[meta]occupancy', (message) => {
    let typedMessage: Metrics = Object.assign(<Metrics>{}, message.data);
    console.log('metrics for '+channelId+': ', JSON.stringify(typedMessage));
  });
}

function getPresenceSets(response: Ably.Types.HttpPaginatedResponse): void {
  let channelsToCheck = "";
  let firstElementAdded = false;
  for (let channelObject of response.items) {
    let channelDetails = Object.assign(<ChannelDetails>{}, channelObject);
    let channelId = channelDetails.channelId;
    if (channelDetails.status.isActive && channelId.match(channelNamespace)) {
      if (!firstElementAdded) {
        firstElementAdded = true;
        channelsToCheck = channelId;
      } else {
        channelsToCheck += "," + channelId;
      }
      subscribeToOccupancyEvents(channelId);
    }
  }

  let content = { "channel": channelsToCheck }
  // Make a batch request to all relevant channels for their presence sets
  rest.request('GET', '/presence', content, null, {}, (err, presenceSet) => {
    if(err) {
      console.log('An error occurred; err = ' + err.toString());
    } else {
      updateCurrentState(presenceSet.items);
    }
  });

  if(response.hasNext()) {
    response.next((err, nextPage) => {
      getPresenceSets(response);
    });
  } else {
    consumeFromAbly();

    shouldSendUpdate = true;
    sendPresenceSetsToAbly();
  }
}

interface PresenceSet {
  channel: string,
  presence: Ably.Types.PresenceMessage[],
}

function updateCurrentState(presenceSet: string[]): void {
  for (let channelPresenceSet of presenceSet) {
    let presenceSet = Object.assign(<PresenceSet>{}, channelPresenceSet);
    let channelName = presenceSet.channel;
    /*
    currentStateByChannel[channelName] = {};
    */

    for (let presenceMessage of presenceSet.presence) {
      let clientId = presenceMessage.clientId;
      let connectionId = presenceMessage.connectionId;

      presenceUpdate(channelName, presenceMessage);

      /*
      // Add the presence message to the object sorted by channel
      createObjectField(currentStateByChannel, channelName, clientId, connectionId, presenceMessage);
      // Add the presence message to the object sorted by clientId
      createObjectField(currentStateByClientId, clientId, channelName, connectionId, presenceMessage);
      // Add the presence message to the object sorted by connectionId
      createObjectField(currentStateByConnectionId, connectionId, clientId, channelName, presenceMessage);
      */
    }
  }
}

function presenceUpdate(channelId:string, update: Ably.Types.PresenceMessage) {
  console.log('presence update for '+channelId+'=' + JSON.stringify(update));
}

/*
function createObjectField(obj, param1: string, param2: string, param3: string, message: Ably.Types.PresenceMessage) {
  if (obj[param1] === undefined) {
    obj[param1] = {};
  }
  if (obj[param1][param2] === undefined) {
    obj[param1][param2] = {};
  }
  obj[param1][param2][param3] = message;
}

function updatePresenceObject(obj, param1: string, param2: string, param3: string, message: Ably.Types.PresenceMessage) {
  let action = message.action;

  if (obj[param1] == undefined) {
    obj[param1] = {};
  }
  if (obj[param1][param2] == undefined) {
    obj[param1][param2] = {};
  }

  if (obj[param1][param2][param3] != undefined &&
      message.timestamp <= obj[param1][param2][param3].timestamp) {
  } else if (action === 'leave') {
    delete obj[param1][param2][param3];
    if (Object.keys(obj[param1][param2]).length === 0) {
      delete obj[param1][param2];
    }
    if (Object.keys(obj[param1]).length === 0) {
      delete obj[param1];
    }
  } else if (action == 'enter') {
    obj[param1][param2][param3] = message;
  }
}
*/