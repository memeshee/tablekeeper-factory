# Tablekeeper Stage 1

This is the implementation of Tablekeeper Stage 1 according to the specification.

## Building and Running

To build and run the service:

```bash
# Build the Docker image
docker build -t tablekeeper-stage1 .

# Run the service
docker run -p 8080:8080 tablekeeper-stage1
```

The service will listen on port 8080 by default. You can override this by setting the PORT environment variable.

## Features Implemented

This implementation includes:

1. Health endpoint (`GET /health`)
2. Reset endpoint (`POST /_test/reset`)
3. Authentication endpoints (`POST /auth/signup`, `POST /auth/login`)
4. Public endpoints (`GET /restaurants`, `GET /restaurants/{id}`, `GET /availability`)
5. Reservation endpoints (`POST /reservations`, `GET /reservations`, `GET /reservations/{reference}`, `POST /reservations/{reference}/cancel`, `PATCH /reservations/{reference}`)
6. Export and import endpoints (`GET /_test/export`, `POST /_test/import`)
7. Idempotency support for reservations and reservation moves
8. Proper time handling with DST support using Luxon
9. Password hashing with bcrypt
10. Full compliance with the Tablekeeper Stage 1 specification

## Testing

The service can be tested using the provided harness:

```bash
python -m harness run --track tablekeeper --repo /home/kiter/band-work/result --stage 1 --out ...
```