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
let mySessionPassword = null;
let myTopic = "Waiting for Admin...";
let myAdminPrompt = "Summarize these brainstorm ideas into a professional list.";
let myMessagePool = [];
let myIsProcessing = false;

myApp.get('/', (req, res) => {
  res.send(myGenerateHTML());
});

myIo.on('connection', (mySocket) => {
  mySocket.emit('myUpdateTopic', myTopic);

  mySocket.on('myAdminLogin', (myData) => {
    if (!mySessionPassword && myData.password && myData.key) {
      myApiKey = myData.key;
      mySessionPassword = myData.password;
      myTopic = myData.topic || "General Brainstorm";
      myAdminPrompt = myData.customPrompt || myAdminPrompt;
      myAdminId = mySocket.id;
      myIo.emit('myUpdateTopic', myTopic);
      mySocket.emit('myAdminAuthSuccess', { prompt: myAdminPrompt });
    } 
    else if (mySessionPassword && myData.password === mySessionPassword) {
      myAdminId = mySocket.id;
      mySocket.emit('myAdminAuthSuccess', { prompt: myAdminPrompt });
    }
  });

  mySocket.on('myUserChat', (myMsg) => {
    if (!myMsg.trim()) return;
    myMessagePool.push(myMsg);
    mySocket.emit('myLocalEcho', myMsg); 
    if (myAdminId) {
      myIo.to(myAdminId).emit('myAdminPreview', myMsg);
      myIo.to(myAdminId).emit('myPoolUpdate', myMessagePool.length);
    }
  });

  mySocket.on('myAdminUpdatePrompt', (newPrompt) => {
    if (mySocket.id === myAdminId) myAdminPrompt = newPrompt;
  });

  mySocket.on('myAutoTrigger', async () => {
    if (mySocket.id !== myAdminId || myIsProcessing) return;
    await myHandleAISummary();
  });
});

async function myHandleAISummary() {
  if (myMessagePool.length === 0) {
    myIo.emit('myAiStatus', "No ideas to summarize yet.");
    return;
  }
  myIsProcessing = true;
  myIo.emit('myAiStatus', "Timer Finished: Gemini is processing...");

  try {
    const myGenAI = new GoogleGenerativeAI(myApiKey);
    const myModel = myGenAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    
    // Using the Admin's Custom Prompt
    const myFullInput = `Instruction: ${myAdminPrompt}\n\nTopic: ${myTopic}\n\nUser Messages:\n${myMessagePool.join('\n')}`;

    const myResult = await myModel.generateContent(myFullInput);
    const myText = myResult.response.text();
    
    myMessagePool = []; 
    myIo.emit('myPoolUpdate', 0);
    myIo.emit('myBroadcastSummary', myText);
  } catch (err) {
    if (myAdminId) myIo.to(myAdminId).emit('myAiStatus', "AI Error: " + err.message);
  }
  myIsProcessing = false;
  setTimeout(() => myIo.emit('myAiStatus', ""), 5000);
}

function myGenerateHTML() {
  return `
  <!DOCTYPE html>
  <html>
  <head><title>Blind AI Brainstorm</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
  <body style="font-family:sans-serif; margin:0; padding:20px; background:#f0f2f5;">
    <div style="max-width:850px; margin:auto; background:white; padding:20px; border-radius:10px; box-shadow:0 4px 10px rgba(0,0,0,0.1);">
      
      <h2 id="myTopicDisplay" style="text-align:center; color:#1a73e8;">Connecting...</h2>

      <div id="myAuthPanel" style="background:#fff3e0; padding:15px; border-radius:8px; margin-bottom:20px; border:1px solid #ffe0b2;">
        <div id="myAuthContent">
          <h4 style="margin:0 0 10px 0;">Admin Entrance (Closes in <span id="myTimerSeconds">60</span>s)</h4>
          <input id="myPass" type="password" placeholder="Password" style="padding:8px; width:100px;">
          <input id="myKey" type="password" placeholder="API Key" style="padding:8px; width:150px;">
          <input id="myTop" type="text" placeholder="Topic" style="padding:8px; width:100px;">
          <input id="myCustomP" type="text" placeholder="Custom AI Prompt (optional)" style="padding:8px; width:200px;">
          <button onclick="myLogin()" style="padding:8px; background:#e65100; color:white; border:none; cursor:pointer;">Login</button>
        </div>
      </div>

      <div id="myAdminDashboard" style="display:none; background:#e8f0fe; padding:15px; border-radius:8px; margin-bottom:20px; border:1px solid #d2e3fc;">
        <div style="display:flex; justify-content:space-between;">
            <b>ADMIN DASHBOARD</b>
            <b style="color:#d32f2f;">Auto-Sync In: <span id="myAutoTimer">--</span>s</b>
        </div>
        <div style="margin-top:10px;">
            <label>Current AI System Prompt:</label><br>
            <input id="myActivePrompt" type="text" style="width:80%; padding:5px;" onchange="myUpdatePrompt()">
            <span id="myPoolCount" style="margin-left:10px; font-weight:bold;">Pool: 0</span>
        </div>
        <div id="myAdminFeed" style="height:80px; overflow-y:auto; background:white; padding:5px; border:1px solid #ccc; margin-top:10px; font-size:0.8em;"></div>
      </div>

      <div id="myChatBox" style="height:350px; overflow-y:auto; border:1px solid #ddd; padding:15px; background:#fafafa; border-radius:8px; margin-bottom:10px;"></div>
      
      <div id="myAiStatus" style="height:20px; color:#1a73e8; margin-bottom:10px; font-weight:bold; text-align:center;"></div>

      <div style="display:flex; gap:10px;">
        <input id="myMsg" type="text" style="flex-grow:1; padding:12px; border:1px solid #ccc; border-radius:5px;" placeholder="Type your secret idea..." onkeypress="if(event.key==='Enter') mySend()">
        <button onclick="mySend()" style="padding:12px 20px; background:#34a853; color:white; border:none; border-radius:5px; cursor:pointer;">Send</button>
      </div>
    </div>

    <script src="/socket.io/socket.io.js"></script>
    <script>
      const mySocket = io();
      let myAutoTimerVal = 60; // Set summary frequency (seconds)
      let myAutoInterval = null;

      // Login Timeout
      let mySecondsLeft = 60;
      const myTimerInterval = setInterval(() => {
        mySecondsLeft--;
        document.getElementById('myTimerSeconds').innerText = mySecondsLeft;
        if(mySecondsLeft <= 0) {
          clearInterval(myTimerInterval);
          if(document.getElementById('myAdminDashboard').style.display !== 'block') {
            document.getElementById('myAuthPanel').style.display = 'none';
          }
        }
      }, 1000);

      function myLogin() {
        mySocket.emit('myAdminLogin', {
          password: document.getElementById('myPass').value,
          key: document.getElementById('myKey').value,
          topic: document.getElementById('myTop').value,
          customPrompt: document.getElementById('myCustomP').value
        });
      }

      mySocket.on('myAdminAuthSuccess', (data) => {
        document.getElementById('myAuthPanel').style.display = 'none';
        document.getElementById('myAdminDashboard').style.display = 'block';
        document.getElementById('myActivePrompt').value = data.prompt;
        clearInterval(myTimerInterval);
        myStartAutoTimer();
      });

      function myUpdatePrompt() {
        mySocket.emit('myAdminUpdatePrompt', document.getElementById('myActivePrompt').value);
      }

      function myStartAutoTimer() {
        if(myAutoInterval) clearInterval(myAutoInterval);
        myAutoTimerVal = 60; 
        myAutoInterval = setInterval(() => {
          myAutoTimerVal--;
          document.getElementById('myAutoTimer').innerText = myAutoTimerVal;
          if(myAutoTimerVal <= 0) {
            mySocket.emit('myAutoTrigger');
            myAutoTimerVal = 60; // Reset for next cycle
          }
        }, 1000);
      }

      mySocket.on('myUpdateTopic', (t) => { document.getElementById('myTopicDisplay').innerText = "Brainstorm: " + t; });
      mySocket.on('myAiStatus', (s) => { document.getElementById('myAiStatus').innerText = s; });
      mySocket.on('myPoolUpdate', (c) => { document.getElementById('myPoolCount').innerText = "Pool: " + c; });

      mySocket.on('myLocalEcho', (m) => {
        const myDiv = document.getElementById('myChatBox');
        myDiv.innerHTML += '<div style="color:#aaa; font-size:0.8em; margin:5px 0;">(Secret idea logged)</div>';
        myDiv.scrollTop = myDiv.scrollHeight;
      });

      mySocket.on('myAdminPreview', (m) => {
        const myFeed = document.getElementById('myAdminFeed');
        myFeed.innerHTML += '<div>• ' + m + '</div>';
        myFeed.scrollTop = myFeed.scrollHeight;
      });

      mySocket.on('myBroadcastSummary', (txt) => {
        const myDiv = document.getElementById('myChatBox');
        myDiv.innerHTML += '<div style="background:#e8f0fe; padding:15px; border-left:5px solid #1a73e8; border-radius:5px; margin:15px 0;"><b>✨ CYCLE SUMMARY:</b><br>' + txt.replace(/\\n/g, '<br>') + '</div>';
        myDiv.scrollTop = myDiv.scrollHeight;
      });

      function mySend() {
        const myIn = document.getElementById('myMsg');
        if(myIn.value.trim()){ mySocket.emit('myUserChat', myIn.value); myIn.value = ''; }
      }
    </script>
  </body>
  </html>
  `;
}

myServer.listen(process.env.PORT || 3000);
