const amqp = require('amqplib/callback_api');
const Ably = require('ably');
const ServerPort = 3000;

let currentState = {};
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
const publishChannel = rest.channels.get('presence-updates');
const channelOptions = {
  params: {
    rewind: '1'
  }
};
const commandChannel = realtime.channels.get('presence-command', channelOptions);

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
  publishChannel.publish('presence-update', currentState);
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

        /* Use the Ably library to decode the message.
           The envelope messages attribute will only contain one message. However, in future versions,
           we may allow optional bundling of messages into a single queue message and as such this
           attribute is an Array to support that in future
        */
        let currentChannel = decodedEnvelope.channel;
        let messages = decodedEnvelope.presence;
        messages.forEach(function(message) {
          let action = message.action;
          let clientId = message.clientId;
          if (currentState[currentChannel][clientId] != undefined &&
              message.timestamp <= currentState[currentChannel][clientId].timestamp) {
                /* Old message, don't do anything with it */
          } else if (action == 3) {
            delete currentState[currentChannel][clientId];
          } else if (action == 2) {
            currentState[currentChannel][clientId] = message;
          }
        });

        /* Remove message from queue */
        ch.ack(item);
      });
    });

    conn.on('error', function(err) { console.error('worker:', 'Connection error!', err); });
  });
};

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
  for (let i = 0; i < response.items.length; i++) {
    let channelId = response.items[i].channelId;
    if (response.items[i].status.isActive && channelId.match(channelNamespace)) {
      if (i == 0) {
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
    currentState[presenceSet[i].channel] = {};
    for (let j = 0; j < presenceSet[i].presence.length; j++) {
      /* We may want to make a unique ID of connID = clientID */
      currentState[presenceSet[i].channel][presenceSet[i].presence[j].clientId] = presenceSet[i].presence[j];
    }
  }
}
