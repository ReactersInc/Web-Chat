import { Server } from 'socket.io'
import { sendMessage as dbSendMessage } from './controller/messageController.js'
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';

let io;

const socketToEmail = new Map();
const emailToSocket = new Map();
const uploadDir = "./uploads";

// Ensure the upload directory exists
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}


export const setupSocket = (server) => {

    io = new Server(server, {
        cors: {
            origin: 'http://localhost:5173', // frontend URL
            methods: ['GET', 'POST'],
            allowedHeaders: ['Content-Type'],
            credentials: true,  // If using cookies/session
        },
    });


    io.use((socket, next) => {
        const token = socket.handshake.auth.token;

        if (token) {
            jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {

                if (err) {
                    return next(new Error('Authentication error'));
                }
                socket.user = decoded; // Attach user info to the socket
                next();
            });
        }

        else {
            next(new Error('Authentication error'));
        }
    });




    io.on('connection', (socket) => {

        console.log('User connected:', socket.id);



        socket.on('identify', (email) => {

            socketToEmail.set(socket.id, email);
            emailToSocket.set(email, socket.id);

            console.log(`User ${email} identified with socket ${socket.id}`);
            console.log('Current emailToSocket map:', emailToSocket);


            //Checking for pending files to be transmitted
            const pendingFiles = fs.readdirSync(uploadDir).filter((file) => {
                return file.includes(email); // Check files that belong to this user
            });

            pendingFiles.forEach((file) => {
                const filePath = path.join(uploadDir, file);
                const [senderEmail, receiverEmail, fileName] = file.split('-');

                console.log(`Sending stored file ${fileName} to ${email} from ${senderEmail}`);
                const fileBuffer = fs.readFileSync(filePath);

                // Split the file into chunks and send them
                const CHUNK_SIZE = 1024; // 1KB per chunk
                for (let i = 0; i < fileBuffer.length; i += CHUNK_SIZE) {

                    const chunk = fileBuffer.slice(i, i + CHUNK_SIZE);
                    const isLastChunk = i + CHUNK_SIZE >= fileBuffer.length;

                    // Emiting the chunk along with sender's email to frontend
                    io.to(socket.id).emit('file_chunk', { senderEmail, fileName, chunk, isLastChunk });

                    if (isLastChunk) {
                        fs.unlinkSync(filePath); // Delete the file after sending
                        console.log(`File ${fileName} sent and deleted from server.`);
                    }

                }

            })
        });


        // Handling file upload in chunks (async/await version)
        socket.on('file_upload', async (data) => {
            try {
                const { senderEmail, receiverEmail, fileName, chunk, isLastChunk } = data;

                if (!senderEmail || !receiverEmail || !fileName || !chunk) {
                    console.error('Missing required fields in file_upload data:', data);
                    return;
                }

                // Generate file path with both sender's and receiver's email
                const filePath = path.join(uploadDir, `${senderEmail}-${receiverEmail}-${fileName}`);
                const receiverSocketId = emailToSocket.get(receiverEmail);

                if (receiverSocketId) {
                    // Receiver is online: send chunk directly
                    console.log(`Sending file chunk for ${fileName} from ${senderEmail} to ${receiverEmail}`);
                    io.to(receiverSocketId).emit('file_chunk', { senderEmail, fileName, chunk, isLastChunk });

                    if (isLastChunk) {
                        console.log(`File successfully sent to ${receiverEmail}`);

                        // Notify the receiver about the file transfer as a message
                        const fileSize = (chunk.length / 1024).toFixed(2) + " KB";
                        const fileMessage = `📂 sent a file: ${fileName} (${fileSize} KB)`;
                        io.to(receiverSocketId).emit('private_message', { senderEmail, message: fileMessage });

                        // Save the file transfer message to the database
                        await dbSendMessage(senderEmail, receiverEmail, fileMessage, null);
                        console.log('File transfer message saved to database');
                    }


                } 
                
                else {
                    // Receiver is offline: save chunk temporarily
                    await fs.promises.appendFile(filePath, Buffer.from(chunk), 'binary');
                    console.log(`Chunk saved for offline user ${receiverEmail}`);

                    if (isLastChunk) {
                        console.log(`File upload completed and stored for offline user ${receiverEmail}`);

                        // Save the file transfer message to the database for the offline user
                        const fileSize = (chunk.length / 1024).toFixed(2) + " KB";
                        const fileMessage = `📂 sent a file: ${fileName} (${fileSize})`;

                        await dbSendMessage(senderEmail, receiverEmail, fileMessage, null);
                        console.log('File transfer message saved to database for offline user');
                    }
                }
            } catch (error) {
                console.error('Error handling file upload:', error);
            }
        });




        //Handling private message
        socket.on('private_message', async (data) => {

            console.log('data: ', data);

            const {  senderEmail, receiverEmail, encryptedData, iv } = data;

            console.log('receiverEmail:', receiverEmail);


            // Finding the socket ID of the receiver by email
            const receiverSocketId = emailToSocket.get(receiverEmail);

            console.log('receiverID :', receiverSocketId)

            if (receiverSocketId) {
                io.to(receiverSocketId).emit('private_message', { senderEmail, message : encryptedData , receiverEmail, iv});
            }

            try {
                const result = await dbSendMessage(senderEmail, receiverEmail, encryptedData, iv);
                console.log('Private message saved to database:', result.message);

                // Emit success back to the sender
                socket.emit('message_status', { status: 'success', message: result.message });

            }

            catch (error) {

                console.error('Error saving private message', error);
                socket.emit('message_status', { status: 'error', message: 'Error sending private message' });

            }
        });



        //Handle group message
        socket.on('group_message', async (data) => {

            const { senderEmail, message, groupId } = data;

            io.to(groupId).emit('group_message', { senderEmail, groupId, message });

            try {
                const result = await dbSendMessage(senderEmail, null, message, groupId);
                console.log('Group message saved to database');

                // Emit status back to sender
                socket.emit('message_status', { status: 'success', message: result.message });

            }

            catch (error) {
                console.error('Error in saving group message', error);
                socket.emit('message_status', { status: 'error', message: 'Error sending group message' });
            }
        });



        // Listen for users joining a group
        socket.on('join_group', (groupId) => {
            socket.join(groupId);
            console.log(`User joined group ${groupId}`);
        });

        // Listen for users leaving a group
        socket.on('leave_group', (groupId) => {
            socket.leave(groupId);
            console.log(`User left group ${groupId}`);
        });



        socket.on('disconnect', () => {

            const email = socketToEmail.get(socket.id);

            if (email) {
                socketToEmail.delete(socket.id);
                emailToSocket.delete(email);
            }
            console.log('User disconnected:', socket.id);

        });

    });

}