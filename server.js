const amqp = require('amqplib/callback_api');
const Ably = require('ably');

let currentStateByChannel = {};
let currentStateByClientId = {};
let currentStateByConnectionId = {};
let shouldSendUpdate = false;
let amqpConnection;

/* AMQP */
const apiKey = process.env.ABLY_API_KEY;
let queueName;
if (process.env.QUEUE_NAME == undefined) {
  queueName = 'presence-queue';
} else {
  queueName = process.env.QUEUE_NAME;
}
const queueEndpoint = "us-east-1-a-queue.ably.io:5671/shared";

/* Ably details */
const rest = new Ably.Rest({ key: apiKey });
const realtime = new Ably.Realtime({ key: apiKey });
let channelNamespace;
if (process.env.NAMESPACE_REGEX === undefined) {
  channelNamespace = /^presence:.*/;
} else {
  channelNamespace = new RegExp(process.env.NAMESPACE_REGEX);
}
const channelForPublishingByChannel = rest.channels.get('presencebatch:by-channel');
const channelForPublishingByClientId = rest.channels.get('presencebatch:by-clientId');
const channelForPublishingByConnection = rest.channels.get('presencebatch:by-connectionId');

const channelOptions = {
  params: {
    rewind: 1
  }
};
const commandChannel = realtime.channels.get('presencebatch:commands', channelOptions);
commandChannel.subscribe('update', (message) => {
  if (message.data == 'start') {
    startPresenceUpdates();
  } else if (message.data == 'stop') {
    stopPresenceUpdates();
  }
});

function startPresenceUpdates() {
  if (amqpConnection != undefined) {
    amqpConnection.close();
  }
  shouldSendUpdate = false;
  getInitialPresenceState();
}

function stopPresenceUpdates() {
  if (amqpConnection != undefined) {
    amqpConnection.close();
  }
  shouldSendUpdate = false;
}

function sendPresenceSetsToAbly() {
  if (shouldSendUpdate) {
    setTimeout(() => {
      channelForPublishingByChannel.publish('presence-update', currentStateByChannel);
      channelForPublishingByClientId.publish('presence-update', currentStateByClientId);
      channelForPublishingByConnection.publish('presence-update', currentStateByConnectionId);
      sendPresenceSetsToAbly();
    }, 3000);
  }
}

function consumeFromAbly() {
  const endpoint = queueEndpoint;
  const url = 'amqps://' + apiKey + '@' + endpoint;

  /* Connect to Ably queue */
  amqp.connect(url, (err, conn) => {
    if (err) {
      return console.error('worker:', 'Queue error!', err);
    }
    amqpConnection = conn;
    /* Create a communication channel */
    conn.createChannel((err, queueChannel) => {
      if (err) {
        return console.error('worker:', 'Queue error!', err);
      }
      consumeFromQueue(queueChannel);
    });

    conn.on('error', (err) => { console.error('worker:', 'Connection error!', err); });
  });
};

function consumeFromQueue(queueChannel) {
  const appId = apiKey.split('.')[0];
  const queue = appId + ":" + queueName;

  queueChannel.consume(queue, (item) => {
    const decodedEnvelope = JSON.parse(item.content);

    let currentChannel = decodedEnvelope.channel;

    let messages = Ably.Realtime.PresenceMessage.fromEncodedArray(decodedEnvelope.presence);

    messages.forEach((message) => {
      let clientId = message.clientId;
      let connectionId = message.connectionId;

      /* Update presence by channel object */
      updatePresenceObject(currentStateByChannel, currentChannel, clientId, connectionId, message);
      /* Update presence by clientID object */
      updatePresenceObject(currentStateByClientId, clientId, currentChannel, connectionId, message);
      /* Update presence by connectionId object */
      updatePresenceObject(currentStateByConnectionId, connectionId, clientId, currentChannel, message);
    });

    /* Remove message from queue */
    queueChannel.ack(item);
  });
}

function getInitialPresenceState() {
  /* Make a request for all currently active channels */
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

function getPresenceSets(response) {
  let channelsToCheck = "";
  let firstElementAdded = false;
  for (let channelObject of response.items) {
    let channelId = channelObject.channelId;
    if (channelObject.status.isActive && channelId.match(channelNamespace)) {
      if (!firstElementAdded) {
        firstElementAdded = true;
        channelsToCheck = channelId;
      } else {
        channelsToCheck += "," + channelId;
      }
    }
  }

  let content = { "channel": channelsToCheck }
  /* Make a batch request to all relevant channels for their presence sets */
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

function updateCurrentState(presenceSet) {
  for (let channelPresenceSet of presenceSet) {
    let channelName = channelPresenceSet.channel;
    currentStateByChannel[channelName] = {};

    for (let presenceMessage of channelPresenceSet.presence) {
      let clientId = presenceMessage.clientId;
      let connectionId = presenceMessage.connectionId;

      /* Add the presence message to the object sorted by channel */
      createObjectField(currentStateByChannel, channelName, clientId, connectionId, presenceMessage);
      /* Add the presence message to the object sorted by clientId */
      createObjectField(currentStateByClientId, clientId, channelName, connectionId, presenceMessage);
      /* Add the presence message to the object sorted by connectionId */
      createObjectField(currentStateByConnectionId, connectionId, clientId, channelName, presenceMessage);
    }
  }
}

function createObjectField(obj, param1, param2, param3, message) {
  if (obj[param1] === undefined) {
    obj[param1] = {};
  }
  if (obj[param1][param2] === undefined) {
    obj[param1][param2] = {};
  }
  obj[param1][param2][param3] = message;
}

function updatePresenceObject(obj, param1, param2, param3, message) {
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
