import {ReactElement} from "react";
import {XCircle} from "react-bootstrap-icons";
import {styled} from "~/stitches.config";

const Container = styled("div", {
    display: "flex",
    gap: "$2",
    alignItems: "center"
});

Container.displayName = "Container";

const Indicator = styled(XCircle, {
    color: "$statusError"
});

const Label = styled("p", {
    fontSize: "0.8rem",
    color: "$text",
    margin: 0
});

export interface InvalidValidationIndicatorProps {
    message: string;
}

export function InvalidValidationIndicator({
    message
}: InvalidValidationIndicatorProps): ReactElement {
    return (
        <Container>
            <Indicator />
            <Label>{message}</Label>
        </Container>
    )
}
