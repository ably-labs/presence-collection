# Ably Presence Collection

The purpose of this app is to aggregate the presence state from across as many channels and namespaces as desired into a single message, published at set intervals.

This can be useful for scenarios where you have many users present in a channel subscribed to the same presence set. As more people join and subscribe to presence updates, the number of messages increase exponentially.

It can also be useful for implementing a form of Global Presence, indicating everyone who's currently online, and where they're active.

## Setup

### Setting up a Reactor Queue and Reactor Rule

The server is going to be consuming updates via AMQP from a Reactor Queue. To do this, [go to your Ably app's 'Queue' tab](https://www.ably.io/accounts/any/apps/any/queues), and select 'Provision a new Queue'. Call it whatever you'd like, and select 'Create'.

Next, go to [the 'Reactor' tab](https://www.ably.io/accounts/any/apps/reactor) in your Ably app, and select the '+ New Reactor Rule' button. Click the 'Reactor Queues' option, choose the queue you chose above, set the Source to 'presence', and set the Channel Filter to whatever captures the channels you're interested in. For example, to subscribe to the namespace 'presence', put in '^presence:.*'.

You now have a Reactor Rule that will send any presence changes on the channels you included to the Queue, which our server will be using.

## Setting up the server

You can either download this repo, or use the [docker hub version](https://hub.docker.com/r/tomably/presence-collection/tags) of it.

### Building from the GitHub repo

If you're building from the GitHub repo, run the following in your local folder for the repo:

`docker build -t NAME_FOR_IMAGE .`

This will build a docker image.

### Building from docker hub

If you're building from docker hub, run the following:

`docker pull tomably/presence-collection:1.1.0`

This will pull the image from docker hub to your local device.

### Running the server

You can now run the app with the following:

`docker run --env ABLY_API_KEY="YOUR_API_KEY" --env QUEUE_NAME="presence-queue" --env NAMESPACE_REGEX="^presence:.*"  tomably/presence-collection:1.1.0`

The environment variables for this are:

* **ABLY_API_KEY** - required - The Ably API key for your Ably App you will be consuming from
* **QUEUE_NAME** - optional (default: `presence-queue`) - The name you gave to your queue which is collecting presence events
* **NAMESPACE_REGEX** - optional (default: `^presence:.*`) - The channels, defined as a RegExp, you wish to consume from. Should match the expression used when creating your Ably Reactor Rule
* **CONSUME_ON_START** - optional (default: `false`) - Whether you wish for this to consume from the queue and sending updates upon starting. If false, you will need to send a message to the channel `presencebatch:commands` with name `update` and data `start` to start this consuming from Ably

if you want to start it by default. If CONSUME_ON_START is not specified, you will need to send the "start" command to the channel named: "presencebatch:commands" in order for the server to start processing.

Replace the Ably API key, queue name (what you called the queue above) and namespace regex to match your needs. In addition, change the image name if you're using a differently named one.

## Server Output

The server once running will subscribe to the 'presencebatch:commands' channel, in addition to checking the last message published into it. If the last message or next message published had a name of *update* and a data field of *start*, the server will start collecting presence details.

Once started, it will establish the current presence state of the channels which match your NAMESPACE_REGEX regex, and store it locally. Currently there are three representations of this data published, to their own relative channels:

#### Channel-centric updates are published to `presencebatch:by-channel`, in the following structure:

```
{
  "channel1" {
    "client1": { "connectionId1": { /* connection 1 in channel's details */ } },
    "client2": { "connectionId2": { /* connection 2 details */ },  "connectionId3": { /* connection 3 details */ } },
  },
  "channel2" {
    "client1": { "connectionId2": { /* connection 2 details */ } }
  }
}
```

#### Client ID-centric updates are published to `presencebatch:by-clientId`, in the following structure:

```
{
  "clientId1" {
    "channel1": { "connectionId1": { /* connection 1 in channel's details */ } },
    "channel2": { "connectionId2": { /* connection 2 details */ },  "connectionId3": { /* connection 3 details */ } },
  },
  "clientId2" {
    "channel1": { "connectionId4": { /* connection 3 details */ } }
  }
}
```

#### Connection ID-centric updates are published to `presencebatch:by-connectionId`, in the following structure:

```
{
  "connectionId1" {
    "clientId1": { "channel1": { /* connection 1 in channel 1's details */ } },
    "clientId2": { "channel1": { /* connection 1 in channel 1's details */ },  "channel2": { /* connection 1 in channel 2's details */ } },
  },
  "connectionId2" {
    "clientId1": { "channel1": { /* connection 2 in channel 1's details */ } }
  }
}
```

Once the initial state is established, the app will consume from the Reactor Queue we set up earlier, and update the local state with any enter or leave events.

Every 3 seconds, the app will then publish this state to the aforementioned channels. Seeing as this object can often be fairly large, with little variation between each publish, it's recommended to subscribe to this channel from clients with [deltas enabled](https://www.ably.io/documentation/realtime/channels/channel-parameters/deltas).
