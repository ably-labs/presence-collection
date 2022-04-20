# Ably Global Presence Aggregation

The purpose of this app is to aggregate the presence state from across as many channels and namespaces as desired.

This can be useful for scenarios where you have many users present in a channel subscribed to the same presence set. As more people join and subscribe to presence updates, the number of messages increase exponentially.

It can also be useful for implementing a form of Global Presence, indicating everyone who's currently online, and where they're active.

## Setup

### Setting up two Ably Queues and Integration Rules

For this code sample the server is going to be consuming updates via AMQP from two Ably Queue: one for presence updates and another for occupancy updates. Occupancy updates are used to verify that the presence member count is as expected. If the member count is not correct then a presence set REST request is done to resynchronise the presence set. Please note that we do not recommend using Ably AMQP queues for heavy workloads.

To create the queues, [go to your Ably app's 'Queues' tab](https://www.ably.com/accounts/any/apps/any/queues), and select 'Provision a new Queue'. Call it whatever you'd like, and select 'Create'. Repeat the process a second time to create another queue.

Next, go to [the 'Integrations' tab](https://www.ably.com/accounts/any/apps/any/integrations) in your Ably app, and select the '+ New Integration Rule' button. Click the 'Ably Queues' option, choose the queue you chose above, set the Source to 'Presence', and set the Channel Filter to whatever captures the channels you're interested in. For example, to subscribe to the namespace 'presence', put in '^presence:.*'. Again, repeat the process but this time select the second queue and set the Source to 'Channel Occupancy'.

You now have two Ably Rules that will send any presence and occupancy changes on the channels you included to the Queues, which our server will be using.

### Building from the GitHub repo

Run the following in your local folder for the repo:

`docker build -t NAME_FOR_IMAGE .`

This will build a docker image.

### Running the server

You can now run the app with the following:

`docker run --env ABLY_API_KEY="YOUR_API_KEY" --env PRESENCE_QUEUE_NAME="presence-queue" --env OCCUPANCY_QUEUE_NAME="presence-queue" --env NAMESPACE_REGEX="^presence:.*" --env FETCH_INITIAL_PRESENCE_STATE="true" -it NAME_FOR_IMAGE`

The environment variables for this are:

* **ABLY_API_KEY**: Ably API key
* **ABLY_ENVIRONMENT**: optional (default: empty) - environment to use (leave empty unless your are using a dedicated environment)
* **NAMESPACE_REGEX**: optional (default: `^presence:.*`) - namespace used to filter channels to fetch presence data on
* **PRESENCE_QUEUE_NAME**: optional (default: `presence-queue`) - presence queue name
* **OCCUPANCY_QUEUE_NAME**: optional (default: `occupancy-queue`) - occupancy queue name
* **QUEUE_ENDPOINT**: optional (default: `eu-west-1-a-queue.ably.io:5671/shared`) - queues endpoint
* **FETCH_INITIAL_PRESENCE_STATE**: optional (default: `false`) - should an initial presence state be fetched? (note: if this is not enabled presence members will be added to the in-memory storage only when a presence event has been received)

Replace the Ably API key, queues name (what you called the two queues above) and namespace regex to match your needs.

## Server Output

The server once running will establish the current presence state of the channels which match your NAMESPACE_REGEX regex, and store it locally. Once the initial state is established, the app will consume from the Ably Queues we set up earlier, and update the local state with any enter or leave events. The global presence set will be displayed on the standard output on every update.