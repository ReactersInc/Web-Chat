import axios from 'axios';

const api = axios.create({
  baseURL: 'https://localhost:3000', // Backend URL
  
  headers: {
    Authorization: `Bearer ${localStorage.getItem('token')}`,
  },
});

export default api;
