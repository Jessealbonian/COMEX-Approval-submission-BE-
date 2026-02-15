# Canteen API Backend

This is the Node.js Express backend for the Canteen application.

## Prerequisites

- [Node.js](https://nodejs.org/) (v14 or later recommended)
- [MySQL](https://www.mysql.com/)

## Setup

1.  **Clone the repository** (if you haven't already).

2.  **Navigate to the `api` directory:**
    ```bash
    cd api
    ```

3.  **Install dependencies:**
    ```bash
    npm install
    ```

4.  **Create a `.env` file:**
    Copy the contents from the example below and paste them into a new file named `.env` in the `api` directory. Update the values with your database credentials and a secure JWT secret.

    ```env
    DB_HOST=localhost
    DB_USER=root
    DB_PASSWORD=
    DB_NAME=canteen_db
    PORT=3000
    JWT_SECRET=your_super_secret_jwt_string
    CORS_ORIGIN=http://localhost:4200
    ```

5.  **Set up the database:**
    -   Make sure your MySQL server is running.
    -   Create a database named `canteen_db` (or the name you specified in your `.env` file).

## Running the Server

-   **Development Mode (with auto-restarting):**
    ```bash
    npm run dev
    ```
    The server will start on the port specified in your `.env` file (default is 3000) and will automatically restart when you make changes to the code.

-   **Production Mode:**
    ```bash
    npm start
    ```

## API Endpoints

-   `GET /`: Welcome message.
-   `POST /auth/login`: Log in a user. Expects `username` and `password` in the body. Returns a JWT.
-   `GET /api/profile`: A protected route that returns the profile of the logged-in user. Requires a valid JWT in the `Authorization` header (`Bearer <token>`).

## Project Structure

```
api/
├── database/
│   └── db.js           # Database connection
├── middleware/
│   └── auth.js         # Authentication guard (JWT)
├── routes/
│   ├── api.js          # Protected API routes
│   └── auth.js         # Authentication routes (login)
├── .env                # Environment variables
├── .htaccess           # Apache reverse proxy config
├── package.json
├── package-lock.json
└── server.js           # Main server file
``` 