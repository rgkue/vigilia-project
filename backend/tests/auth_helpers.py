from app import db


def authenticate_demo(client):
    with db.conexion() as connection:
        connection.execute("DELETE FROM auth_attempts")
    options = client.get("/auth/options").json()
    client.headers["x-csrf-token"] = options["csrf_token"]
    qr = client.post("/auth/admin/qr/start", json={"qr": "vigilia:admin:demo-admin"})
    assert qr.status_code == 200, qr.text
    client.headers["x-csrf-token"] = qr.json()["csrf_token"]
    response = client.post("/auth/demo-admin", json={})
    assert response.status_code == 200, response.text
    client.headers["x-csrf-token"] = response.json()["csrf_token"]
    return response.json()
