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

`docker pull tomably/presence-collection:1.0.0`

This will pull the image from docker hub to your local device.

### Running the server

You can now run the app with the following:

`docker run --env ABLY_API_KEY="YOUR_API_KEY" --env QUEUE_NAME="presence-queue" --env NAMESPACE_REGEX="^presence:.*"  tomably/presence-collection:1.0.0
`

Replace the Ably API key, queue name (what you called the queue above) and namespace regex to match your needs. In addition, change the image name if you're using a differently named one.


## Server Output

The server once running will subscribe to the 'presence-command' channel, in addition to checking the last message published into it. If the last message or next message published had a name of *update* and a data field of *start*, the server will start collecting presence details.

Once started, it will establish the current presence state of the channels which match your NAMESPACE_REGEX regex, and store it locally. Currently the structure of the data is:

```
{
  "channel1" {
    "client1": { // client 1 details },
    "client2": { // client 2 details }
  },
  "channel2" {
     "client1": { // client 1 details },
     "client3": { // client 3 details },
  }
}
```

Once the initial state is established, the app will consume from the Reactor Queue we set up earlier, and update the local state with any enter or leave events.

Every 3 seconds, the app will then publish this state to the Ably channel `presence-update`. Seeing as this object can often be fairly large, with little variation between each publish, it's recommended to subscribe to this channel from clients with [deltas enabled](https://www.ably.io/documentation/realtime/channels/channel-parameters/deltas).
