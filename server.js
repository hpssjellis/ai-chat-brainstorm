const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const myApp = express();
const myServer = http.createServer(myApp);
const myIo = new Server(myServer);

// Global App State
let myAdminId = null;
let myApiKey = null;
let myTopic = "Waiting for Admin...";
let myPrompt = "Summarize these notes into a cohesive brainstorm list.";
let myMessagePool = [];
let myIsProcessing = false;

// Serve the UI directly
myApp.get('/', (req, res) => {
  res.send(myGenerateHTML());
});

myIo.on('connection', (mySocket) => {
  // First person becomes Admin
  if (!myAdminId) {
    myAdminId = mySocket.id;
    mySocket.emit('myAdminStatus', true);
  }

  // Sync state for new users
  mySocket.emit('myUpdateTopic', myTopic);

  // Admin sets up the session
  mySocket.on('myAdminSetup', (myData) => {
    if (mySocket.id !== myAdminId) return;
    myApiKey = myData.key;
    myTopic = myData.topic;
    myPrompt = myData.prompt || myPrompt;
    myIo.emit('myUpdateTopic', myTopic);
  });

  // User sends a message
  mySocket.on('myUserChat', (myMsg) => {
    myMessagePool.push(myMsg);
    myIo.emit('myChatLogged', myMsg); // Shows everyone the message arrived
  });

  // Admin requests a summary
  mySocket.on('myTriggerSummary', async () => {
    if (mySocket.id !== myAdminId || myIsProcessing || myMessagePool.length === 0) return;
    await myHandleAISummary(false);
  });

  // Admin requests a private TL;DR
  mySocket.on('myTriggerTLDR', async () => {
    if (mySocket.id !== myAdminId || myIsProcessing) return;
    await myHandleAISummary(true);
  });

  mySocket.on('disconnect', () => {
    if (mySocket.id === myAdminId) myAdminId = null;
  });
});

async function myHandleAISummary(isTLDR) {
  myIsProcessing = true;
  try {
    const myGenAI = new GoogleGenerativeAI(myApiKey);
    const myModel = myGenAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    
    let myContext = isTLDR ? "Provide a short TL;DR summary of everything so far." : myPrompt;
    const myFullInput = `${myContext}\n\nTopic: ${myTopic}\n\nMessages:\n${myMessagePool.join('\n')}`;

    const myResult = await myModel.generateContent(myFullInput);
    const myText = myResult.response.text();
    
    // Read time: ~200 words per minute
    const myWaitSeconds = Math.max(5, Math.ceil((myText.split(' ').length / 200) * 60));

    if (isTLDR) {
      myIo.to(myAdminId).emit('myPrivateTLDR', myText);
    } else {
      myMessagePool = []; // Clear pool after public broadcast
      myIo.emit('myBroadcastSummary', { text: myText, wait: myWaitSeconds });
    }
  } catch (err) {
    myIo.to(myAdminId).emit('myError', err.message);
  }
  myIsProcessing = false;
}

function myGenerateHTML() {
  return `
  <!DOCTYPE html>
  <html>
  <head><title>Brainstorm Hub</title></head>
  <body style="font-family:sans-serif; margin:20px; background:#f4f4f4;">
    <h2 id="myTopicDisplay">Waiting...</h2>
    
    <div id="myAdminPanel" style="display:none; border:2px solid #333; padding:10px; margin-bottom:10px;">
      <b>Admin Tools</b><br>
      <input id="myApiKey" type="password" placeholder="Gemini API Key">
      <input id="myTopicInput" type="text" placeholder="Topic Name"><br>
      <button onclick="mySetup()">Start Session</button>
      <button onclick="myGetSummary()">Broadcast Summary</button>
      <button onclick="myGetTLDR()">Private TL;DR</button>
    </div>

    <div id="myChatBox" style="height:300px; overflow-y:scroll; background:white; border:1px solid #ccc; padding:10px;"></div>
    
    <div id="myInputArea" style="margin-top:10px;">
      <input id="myMsg" type="text" style="width:70%" placeholder="Add an idea...">
      <button id="mySendBtn" onclick="mySend()">Send</button>
    </div>

    <div id="myTimer" style="color:red; font-weight:bold; margin-top:5px;"></div>

    <script src="/socket.io/socket.io.js"></script>
    <script>
      const mySocket = io();
      let myIsAdmin = false;

      mySocket.on('myAdminStatus', (status) => {
        myIsAdmin = status;
        if(status) document.getElementById('myAdminPanel').style.display = 'block';
      });

      mySocket.on('myUpdateTopic', (t) => {
        document.getElementById('myTopicDisplay').innerText = "Topic: " + t;
      });

      mySocket.on('myChatLogged', (m) => {
        const myDiv = document.getElementById('myChatBox');
        myDiv.innerHTML += '<div>' + m + '</div>';
        myDiv.scrollTop = myDiv.scrollHeight;
      });

      mySocket.on('myBroadcastSummary', (data) => {
        const myDiv = document.getElementById('myChatBox');
        myDiv.innerHTML += '<div style="background:#e1f5fe; padding:10px; border-left:5px solid #03a9f4;"><b>AI Summary:</b><br>' + data.text + '</div>';
        myLockInput(data.wait);
      });

      mySocket.on('myPrivateTLDR', (txt) => {
        alert("PRIVATE TL;DR:\\n" + txt);
      });

      function mySetup() {
        mySocket.emit('myAdminSetup', {
          key: document.getElementById('myApiKey').value,
          topic: document.getElementById('myTopicInput').value
        });
      }

      function mySend() {
        const myIn = document.getElementById('myMsg');
        if(myIn.value) {
          mySocket.emit('myUserChat', myIn.value);
          myIn.value = '';
        }
      }

      function myGetSummary() { mySocket.emit('myTriggerSummary'); }
      function myGetTLDR() { mySocket.emit('myTriggerTLDR'); }

      function myLockInput(sec) {
        const myBtn = document.getElementById('mySendBtn');
        const myTimer = document.getElementById('myTimer');
        myBtn.disabled = true;
        let myLeft = sec;
        const myInt = setInterval(() => {
          myTimer.innerText = "Read Time Remaining: " + myLeft + "s";
          if(myLeft-- <= 0) {
            clearInterval(myInt);
            myBtn.disabled = false;
            myTimer.innerText = "";
          }
        }, 1000);
      }
    </script>
  </body>
  </html>
  `;
}

myServer.listen(process.env.PORT || 3000);
