export async function getOrder(orderID, client) {
    const order = await client.getOrder(
        orderID,
    );
    console.log(order);
    return order;
}