// @flow
import React, { Component } from "react";
import type { ElementRef } from "react";

import type { ChatMessage, MessageType } from "./Chatroom";
import Chatroom from "./Chatroom";
import { sleep, uuidv4 } from "./utils";

const CHATWOOT_ENDPOINT = '136.233.77.66:3000'
const CHAT_SERVER_ENDPOINT = 'http://localhost:3033'

type ConnectedChatroomProps = {
  userId: string,
  host: string,
  welcomeMessage: ?string,
  title: string,
  waitingTimeout: number,
  speechRecognition: ?string,
  messageBlacklist: Array<string>,
  handoffIntent: string,
  fetchOptions?: RequestOptions,
  voiceLang: ?string
};
type ConnectedChatroomState = {
  messages: Array<ChatMessage>,
  messageQueue: Array<ChatMessage>,
  isOpen: boolean,
  waitingForBotResponse: boolean,
  currenthost: string,
  currenttitle: string
};

type RasaMessage =
  | {| sender_id: string, text: string |}
  | {|
      sender_id: string,
      buttons: Array<{ title: string, payload: string, selected?: boolean }>,
      text?: string
    |}
  | {| sender_id: string, image: string, text?: string |}
  | {| sender_id: string, attachment: string, text ?: string |}
  | {| sender_id: string, custom: string, text?: string |};



function getCustomerPubsub(conv_id){
  return new Promise((resolve, reject) => {
    fetch(CHAT_SERVER_ENDPOINT + `/conversations/${conv_id}/pubsub`)
      .then(response => response.json())
      .then(data => {
        if(data.pubsub){
          console.log(`recieved pubsub token = ${data['pubsub']}`)
          resolve(data.pubsub)
        }
      }).catch(e => {
        console.error(e)
        resolve(null)
      })
  })
  
}

function parse_conv_id_from_url(url){
  console.log('url = ',url)
  let slice_start = url.indexOf('conversations/') + 'conversations/'.length
  console.log(`slice_start: ${slice_start}`)
  let slice_end = url.indexOf('/messages')
  let conv_id_str = url.slice(slice_start, slice_end)
  let is_numeric = !isNaN(conv_id_str) && !isNaN(parseFloat(conv_id_str))
  console.log(`parsed conv_id = ${conv_id_str}, is_numeric = ${is_numeric}`)
  if(is_numeric){
    return conv_id_str
  }
  else{
    console.error(`parsed conv_id ${conv_id_str} is not a number!`)
    return null
  }
}

export default class ConnectedChatroom extends Component<
  ConnectedChatroomProps,
  ConnectedChatroomState
> {
  state = {
    messages: [],
    messageQueue: [],
    isOpen: false,
    waitingForBotResponse: false,
    currenthost: `${this.props.host}`,
    currenttitle: `${this.props.title}`
  };

  static defaultProps = {
    waitingTimeout: 5000,
    messageBlacklist: ["_restart", "_start", "/restart", "/start"],
    handoffIntent: "handoff"
  };

  handoffpayload = `\\/(${this.props.handoffIntent})\\b.*`;
  handoffregex = new RegExp( this.handoffpayload );
  waitingForBotResponseTimer: ?TimeoutID = null;
  messageQueueInterval: ?IntervalID = null;
  chatroomRef = React.createRef<Chatroom>();

  componentDidMount() {
    const messageDelay = 800; //delay between message in ms
    this.messageQueueInterval = window.setInterval(
      this.queuedMessagesInterval,
      messageDelay
    );

    if (this.props.welcomeMessage) {
      const welcomeMessage = {
        message: { type: "text", text: this.props.welcomeMessage },
        time: Date.now(),
        username: "bot",
        uuid: uuidv4()
      };
      this.setState({ messages: [welcomeMessage] });
    }
  }

  componentWillUnmount() {
    if (this.waitingForBotResponseTimer != null) {
      window.clearTimeout(this.waitingForBotResponseTimer);
      this.waitingForBotResponseTimer = null;
    }
    if (this.messageQueueInterval != null) {
      window.clearInterval(this.messageQueueInterval);
      this.messageQueueInterval = null;
    }
  }

  sendMessage = async (messageText: string) => {
    if (messageText === "") return;

    const messageObj = {
      message: { type: "text", text: messageText },
      time: Date.now(),
      username: this.props.userId,
      uuid: uuidv4()
    };

    if (!this.props.messageBlacklist.includes(messageText) && !messageText.match(this.handoffregex)) {
      this.setState({
        // Reveal all queued bot messages when the user sends a new message
        messages: [
          ...this.state.messages,
          ...this.state.messageQueue,
          messageObj
        ],
        messageQueue: []
      });
    }

    this.setState({ waitingForBotResponse: true });
    if (this.waitingForBotResponseTimer != null) {
      window.clearTimeout(this.waitingForBotResponseTimer);
    }
    this.waitingForBotResponseTimer = setTimeout(() => {
      this.setState({ waitingForBotResponse: false });
    }, this.props.waitingTimeout);

    const rasaMessageObj = {
      message: messageObj.message.text,
      sender: this.props.userId
    };

    const fetchOptions = Object.assign({}, {
      method: "POST",
      body: JSON.stringify(rasaMessageObj),
      headers: {
        "Content-Type": "application/json"
      }
    }, this.props.fetchOptions);

    const response = await fetch(
      `${this.state.currenthost}/webhooks/rest/webhook`,
      fetchOptions
    );
    const messages = await response.json();

    this.parseMessages(messages);

    if (window.ga != null) {
      window.ga("send", "event", "chat", "chat-message-sent");
    }
  };

  createNewBotMessage(botMessageObj: MessageType): ChatMessage {
    return {
      message: botMessageObj,
      time: Date.now(),
      username: "bot",
      uuid: uuidv4()
    };
  }


  async parseMessages(RasaMessages: Array<RasaMessage>) {
    const validMessageTypes = ["text", "image", "buttons", "attachment", "custom", "quick_replies"];

    let expandedMessages = [];

    RasaMessages.filter((message: RasaMessage) =>
      validMessageTypes.some(type => type in message)
    ).forEach((message: RasaMessage) => {
      let validMessage = false;
      if (message.text) {
        validMessage = true;
        expandedMessages.push(
          this.createNewBotMessage({ type: "text", text: message.text })
        );
      }

      if (message.buttons) {
        validMessage = true;
        expandedMessages.push(
          this.createNewBotMessage({ type: "button", buttons: message.buttons })
        );
      }

      // supporting quick_replies for botfront
      if (message.quick_replies) {
        validMessage = true;
        expandedMessages.push(
          this.createNewBotMessage({ type: "button", buttons: message.quick_replies })
        );
      }

      if (message.image) {
        validMessage = true;
        expandedMessages.push(
          this.createNewBotMessage({ type: "image", image: message.image })
        );
      }

      // probably should be handled with special UI elements
      if (message.attachment) {
        validMessage = true;
        expandedMessages.push(
          this.createNewBotMessage({ type: "text", text: message.attachment })
        );
      }

      if (message.custom && message.custom.handoff_host) {
        validMessage = true;
        this.setState({
          currenthost: message.custom.handoff_host
        });
        if (message.custom.title) {
          this.setState({
            currenttitle: message.custom.title
          })
        }
        console.log(`switching to ${message.custom.handoff_host}`);
        this.sendMessage(`/${this.props.handoffIntent}{"from_host":"${this.props.host}"}`);
        // ws subscribe
        
        const connection = new WebSocket(`ws://${CHATWOOT_ENDPOINT}/cable`);
        // Connection opened
        connection.addEventListener('open', function (event) {
          console.log("websocket connection established.")
          const conv_id = parse_conv_id_from_url(message.custom.handoff_host)
          if(conv_id){
            getCustomerPubsub(conv_id)
            .then(customer_pubsub_token => {
              if(customer_pubsub_token){
                console.log("sending subscription request to live chat server")
                connection.send(JSON.stringify({ command:"subscribe", identifier: "{\"channel\":\"RoomChannel\",\"pubsub_token\":\""+ customer_pubsub_token+"\"}" }));
              }
            })
            
          }
        });

        // Listen for messages
        connection.addEventListener('message', function (event) {
          console.log('Message from server ');
          console.log(event.data.message)
          const event_data = JSON.parse(event.data)
          if(event_data.type === 'ping'){
            console.log("ping message")
          } else if(event_data.message){
            const event_type = event_data.message.event
            console.log(`event type: ${event_type}`)
            if(event_type === 'message.created'){
              const message_data = event_data.message.data
              if (message_data.message_type === 1){
                console.log(`new message from agent: ${message_data.content}`)
                this.createNewBotMessage({ type: "text", text: message_data.content })
              }
            }
          } else{
            console.log(`unknown event:`)
            console.log(event_data)
          }
        });

        connection.addEventListener('close', function (event) {
          console.log('socker connection closed');
        });

        connection.addEventListener('error', function (event) {
          console.log('Error in socket connection connection');
        });
        return;
      }

      if (validMessage === false)
        throw Error("Could not parse message from Bot or empty message");
    });

    // Bot messages should be displayed in a queued manner. Not all at once
    const messageQueue = [...this.state.messageQueue, ...expandedMessages];
    this.setState({
      messageQueue,
      waitingForBotResponse: messageQueue.length > 0
    });
  }

  queuedMessagesInterval = () => {
    const { messages, messageQueue } = this.state;

    if (messageQueue.length > 0) {
      const message = messageQueue.shift();
      const waitingForBotResponse = messageQueue.length > 0;

      this.setState({
        messages: [...messages, message],
        messageQueue,
        waitingForBotResponse
      });
    }
  };

  handleButtonClick = (buttonTitle: string, payload: string) => {
    this.sendMessage(payload);
    if (window.ga != null) {
      window.ga("send", "event", "chat", "chat-button-click");
    }
  };

  handleToggleChat = () => {
    if (window.ga != null) {
      if (this.state.isOpen) {
        window.ga("send", "event", "chat", "chat-close");
      } else {
        window.ga("send", "event", "chat", "chat-open");
      }
    }
    this.setState({ isOpen: !this.state.isOpen });
  };

  render() {
    const { messages, waitingForBotResponse } = this.state;

    const renderableMessages = messages
      .filter(
        message =>
          message.message.type !== "text" || (
          !this.props.messageBlacklist.includes(message.message.text) &&
          !message.message.text.match(this.handoffregex) )
      )
      .sort((a, b) => a.time - b.time);

    return (
      <Chatroom
        messages={renderableMessages}
        title={this.state.currenttitle}
        waitingForBotResponse={waitingForBotResponse}
        isOpen={this.state.isOpen}
        speechRecognition={this.props.speechRecognition}
        onToggleChat={this.handleToggleChat}
        onButtonClick={this.handleButtonClick}
        onSendMessage={this.sendMessage}
        ref={this.chatroomRef}
        voiceLang={this.props.voiceLang}
        host={this.state.currenthost}
      />
    );
  }
}
