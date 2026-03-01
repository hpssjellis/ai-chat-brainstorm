const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const myApp = express();
const myServer = http.createServer(myApp);
const myIo = new Server(myServer);

// App State
let myAdminId = null;
let myApiKey = null;
let myTopic = "Waiting for Admin to set topic...";
let myPrompt = "Summarize these brainstorm ideas into a cohesive list:";
let myMessagePool = [];
let myIsProcessing = false;

myIo.on('connection', (mySocket) => {
    // First user becomes Admin
    if (!myAdminId) {
        myAdminId = mySocket.id;
        mySocket.emit('admin_status', true);
    }

    // Send current state to new joiners
    mySocket.emit('topic_update', myTopic);

    // Admin Setup
    mySocket.on('admin_setup', (data) => {
        if (mySocket.id !== myAdminId) return;
        myApiKey = data.key;
        myTopic = data.topic;
        myPrompt = data.prompt || myPrompt;
        myIo.emit('topic_update', myTopic);
    });

    // User sends a chat
    mySocket.on('user_chat', (msg) => {
        myMessagePool.push(`${msg.user}: ${msg.text}`);
        // Optionally broadcast individual chats here or keep them private until summary
    });

    // The Processing Loop (Triggered by Admin or Timer)
    mySocket.on('request_summary', async () => {
        if (mySocket.id !== myAdminId || myIsProcessing || myMessagePool.length === 0) return;
        
        myIsProcessing = true;
        const myGenAI = new GoogleGenerativeAI(myApiKey);
        const myModel = myGenAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        const myFullPrompt = `${myPrompt}\n\nContext: ${myTopic}\n\nMessages:\n${myMessagePool.join('\n')}`;
        
        try {
            const myResult = await myModel.generateContent(myFullPrompt);
            const myText = myResult.response.text();
            
            // Calculate read time (~200 words per minute)
            const myWordCount = myText.split(/\s+/).length;
            const myReadSeconds = Math.max(5, Math.ceil((myWordCount / 200) * 60));

            // Clear pool for next round
            myMessagePool = [];
            
            // Broadcast to everyone
            myIo.emit('new_summary', { 
                text: myText, 
                wait: myReadSeconds 
            });

        } catch (err) {
            mySocket.emit('error', 'AI Failed: ' + err.message);
        } finally {
            myIsProcessing = false;
        }
    });

    mySocket.on('disconnect', () => {
        if (mySocket.id === myAdminId) myAdminId = null; 
    });
});

myServer.listen(process.env.PORT || 3000);
