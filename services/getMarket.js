export async function getMarket(conditionId, client) {
    const market = await client.getMarket(
        conditionId,
    );
    console.log(market);
    return market;
}