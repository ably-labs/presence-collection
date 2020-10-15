const amqp = require('amqplib/callback_api');
const Ably = require('ably');
const ServerPort = 3000;

let currentStateByChannel = {};
let currentStateByClientId = {};
let currentStateByConnectionId = {};
let updatingLoop;
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
const publishByChannelChannel = rest.channels.get('presencebatch:by-channel');
const publishByClientIdChannel = rest.channels.get('presencebatch:by-clientId');
const publishByConnectionIdChannel = rest.channels.get('presencebatch:by-connectionId');

const channelOptions = {
  params: {
    rewind: 1
  }
};
const commandChannel = realtime.channels.get('presencebatch:commands', channelOptions);
commandChannel.subscribe(function(message) {
  if (message.name == 'update' && message.data == 'start') {
    startUpdates();
  } else if (message.name == 'update' && message.data == 'stop') {
    stopUpdates();
  }
});

function startUpdates() {
  initializeState();
}

function stopUpdates() {
  if (amqpConnection != undefined) {
    amqpConnection.close();
  }
}

function updateAbly() {
  publishByChannelChannel.publish('presence-update', currentStateByChannel);
  publishByClientIdChannel.publish('presence-update', currentStateByClientId);
  publishByConnectionIdChannel.publish('presence-update', currentStateByConnectionId);
}

function consumeFromAbly() {
  const appId = apiKey.split('.')[0];
  const queue = appId + ":" + queueName;
  const endpoint = queueEndpoint;
  const url = 'amqps://' + apiKey + '@' + endpoint;

  /* Connect to Ably queue */
  amqp.connect(url, (err, conn) => {
    if (err) {
      return console.error('worker:', 'Queue error!', err);
    }
    amqpConnection = conn;
    /* Create a communication channel */
    conn.createChannel((err, ch) => {
      if (err) {
        return console.error('worker:', 'Queue error!', err);
      }

      /* Wait for messages published to the Ably Reactor queue */
      ch.consume(queue, (item) => {
        const decodedEnvelope = JSON.parse(item.content);

        let currentChannel = decodedEnvelope.channel;
        let messages = decodedEnvelope.presence;

        messages.forEach(function(message) {
          let clientId = message.clientId;
          let connectionId = message.connectionId;

          /* Update presence by channel object */
          updateObject(currentStateByChannel, currentChannel, clientId, connectionId, message);
          /* Update presence by clientID object */
          updateObject(currentStateByClientId, clientId, currentChannel, connectionId, message);
          /* Update presence by connectionId object */
          updateObject(currentStateByConnectionId, connectionId, clientId, currentChannel, message);
        });

        /* Remove message from queue */
        ch.ack(item);
      });
    });

    conn.on('error', function(err) { console.error('worker:', 'Connection error!', err); });
  });
};

function updateObject(obj, param1, param2, param3, message) {
  let action = message.action;

  if (obj[param1] == undefined) {
    obj[param1] = {};
  }
  if (obj[param1][param2] == undefined) {
    obj[param1][param2] = {};
  }

  if (obj[param1][param2][param3] != undefined &&
      message.timestamp <= obj[param1][param2][param3].timestamp) {
    /* Old message, don't do anything with it */
  } else if (action == 3) {
    /* 3 is the leave event, so remove them from the channel */
    delete obj[param1][param2][param3];
    if (Object.keys(obj[param1][param2]).length === 0) {
      delete obj[param1][param2];
    }
    if (Object.keys(obj[param1]).length === 0) {
      delete obj[param1];
    }
  } else if (action == 2) {
    /* 2 is the enter event, so add them to the channel */
    obj[param1][param2][param3] = message;
  }
}

function initializeState() {
  /* Make a request for all currently active channels */
  rest.request(
    'get',
    '/channels',
    {direction: 'forwards'},
    null,
    null,
    function(err, response) {
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
  for (let i = 0; i < response.items.length; i++) {
    let channelId = response.items[i].channelId;
    if (response.items[i].status.isActive && channelId.match(channelNamespace)) {
      if (!firstElementAdded) {
        firstElementAdded = true;
        channelsToCheck = channelId;
      } else {
        channelsToCheck += "," + channelId;
      }
    }
  }

  var content = { "channel": channelsToCheck }
  /* Make a batch request to all relevant channels for their presence sets */
  rest.request('GET', '/presence', content, null, {}, function(err, presenceSet) {
    if(err) {
      console.log('An error occurred; err = ' + err.toString());
    } else {
      updateCurrentState(presenceSet.items);
    }
  });

  if(response.hasNext()) {
    response.next(function(err, nextPage) {
      getPresenceSets(response);
    });
  } else {
    consumeFromAbly();
    updatingLoop = setInterval(updateAbly, 3000);
  }
}

function updateCurrentState(presenceSet) {
  for (let i = 0; i < presenceSet.length; i++) {
    currentStateByChannel[presenceSet[i].channel] = {};

    for (let j = 0; j < presenceSet[i].presence.length; j++) {
      let message = presenceSet[i].presence[j];
      let clientId = presenceSet[i].presence[j].clientId;
      let connectionId = presenceSet[i].presence[j].connectionId;
      let channel = presenceSet[i].channel;

      /* Add the presence message to the object sorted by channel */
      createObjectField(currentStateByChannel, channel, clientId, connectionId, message);
      /* Add the presence message to the object sorted by clientId */
      createObjectField(currentStateByClientId, clientId, channel, connectionId, message);
      /* Add the presence message to the object sorted by connectionId */
      createObjectField(currentStateByConnectionId, connectionId, clientId, channel, message);
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
}
