import { io } from 'socket.io-client';

const BASE_URL = import.meta.env.VITE_API_URL;

// Connects to this browser's own server. The cookie is sent automatically
// thanks to withCredentials, so the server can identify the logged-in user.
export const socket = io(BASE_URL, {
  withCredentials: true,
  autoConnect: false, // we connect manually when a patient view mounts
  reconnectionAttempts: 5, // avoid flooding the console while backend isn't running yet
});